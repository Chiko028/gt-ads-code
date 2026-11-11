"""Codex-Kontingent-Gate (nur Python-Standardbibliothek).

Regeln (vom Betreiber vorgegeben, hier technisch erzwungen):
- Ein neuer Codex-Auftrag startet NUR, wenn BEIDE Fenster (5 Stunden UND Woche) zuverlaessig gemessen sind und in BEIDEN
  die Auslastung plus Sicherheitsreserve unter der Grenze (Standard 80 %) liegt.
- Nichts wird geschaetzt oder erfunden: fehlt ein Fenster, ist ein Wert unplausibel oder die Messung veraltet -> GESPERRT.
- Messquelle ist ausschliesslich der von OpenClaw gelieferte Anbieter-Snapshot (`openclaw status --usage --json`, kontoweit).

Bekannte Schwaechen der Normalisierung in OpenClaw 2026.11.2 (im Code gelesen), gegen die dieses Gate absichert:
- fehlendes `used_percent` wird zu 0 % (`|| 0`) -> Monotonie-Pruefung: innerhalb desselben Fensters (gleiches resetAt) darf die
  Auslastung nicht sinken; sinkt sie, gilt die Messung als Anomalie und das Gate sperrt.
- fehlende Fensterlaenge wird zu 3 h / 1 Tag -> es werden NUR exakt die Bezeichnungen "5h" und "Week" akzeptiert.
"""

import json
import sqlite3
import threading
import time

FIVE_HOUR = "5h"
WEEK = "Week"
DEFAULTS = {"limit_percent": 80.0, "safety_margin_percent": 10.0, "max_snapshot_age_s": 120, "monotonic_tolerance": 1.0,
            "delta_factor": 1.5, "min_headroom_percent": 0.0}


class QuotaUnavailable(Exception):
    """Messung nicht moeglich oder nicht vertrauenswuerdig (Text ohne Geheimnisse)."""


def _num(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or value in (float("inf"), float("-inf")):
        return None
    return float(value)


def parse_snapshot(raw, now):
    """Raw-JSON von `openclaw status --usage --json` -> {"plan","five","week","updated_at"}; wirft QuotaUnavailable."""
    text = raw if isinstance(raw, str) else raw.decode("utf-8", "replace")
    data = None
    dec = json.JSONDecoder()
    pos = text.find("{")
    while pos >= 0 and data is None:  # erstes vollstaendiges JSON-Objekt mit "usage"; Protokollzeilen davor/danach werden ignoriert
        try:
            obj, _ = dec.raw_decode(text, pos)
            if isinstance(obj, dict) and "usage" in obj:
                data = obj
        except ValueError:
            pass
        pos = text.find("{", pos + 1)
    if data is None:
        from redact import redact
        hint = redact(" ".join(text.split())[-160:], 160) if text.strip() else "leer"
        raise QuotaUnavailable("Usage-Ausgabe nicht lesbar (Ende der Ausgabe: %s)" % hint)
    usage = data.get("usage") if isinstance(data, dict) else None
    if not isinstance(usage, dict) or not isinstance(usage.get("providers"), list):
        raise QuotaUnavailable("keine Usage-Daten im Status")
    updated = _num(usage.get("updatedAt"))
    if updated is None:
        raise QuotaUnavailable("Usage-Daten ohne Zeitstempel")
    providers = [p for p in usage["providers"] if isinstance(p, dict) and p.get("provider") == "openai"]
    if len(providers) != 1:
        raise QuotaUnavailable("kein (eindeutiger) OpenAI-Eintrag im Usage-Snapshot (nicht angemeldet?)")
    prov = providers[0]
    if prov.get("error"):
        raise QuotaUnavailable("Anbieter meldet Fehler bei der Kontingentabfrage")
    wins = prov.get("windows")
    if not isinstance(wins, list):
        raise QuotaUnavailable("keine Fenster im OpenAI-Snapshot")
    by_label = {}
    for w in wins:
        if isinstance(w, dict) and isinstance(w.get("label"), str):
            by_label.setdefault(w["label"], []).append(w)
    out = {}
    for key, label in (("five", FIVE_HOUR), ("week", WEEK)):
        found = by_label.get(label, [])
        if len(found) != 1:
            raise QuotaUnavailable("Fenster '%s' nicht eindeutig messbar (Tarif ohne dieses Fenster?)" % label)
        used, reset = _num(found[0].get("usedPercent")), _num(found[0].get("resetAt"))
        if used is None or not 0.0 <= used <= 100.0:
            raise QuotaUnavailable("Fenster '%s': Auslastung fehlt oder unplausibel" % label)
        if reset is None:
            raise QuotaUnavailable("Fenster '%s': Ruecksetzzeit fehlt" % label)
        if reset / 1000.0 <= now:
            raise QuotaUnavailable("Fenster '%s': Ruecksetzzeit liegt in der Vergangenheit (veraltete Messung)" % label)
        out[key] = {"used": used, "reset_at": reset}
    out["plan"] = prov.get("plan") if isinstance(prov.get("plan"), str) else None
    out["updated_at"] = updated
    return out


class QuotaGate:
    def __init__(self, db_path, fetch, cfg=None, clock=time.time):
        self.fetch, self.clock = fetch, clock
        self.cfg = dict(DEFAULTS, **(cfg or {}))
        self.lock = threading.RLock()
        self.check_lock = threading.RLock()  # genau eine Messung gleichzeitig (CLI-Aufruf ist langsam)
        self._last, self._last_ts, self._refreshing = None, None, False
        self.db = sqlite3.connect(db_path, check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS quota_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, five_used REAL, five_reset REAL,
            week_used REAL, week_reset REAL, plan TEXT, allowed INTEGER NOT NULL, reason TEXT)""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS quota_cost (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, review_id INTEGER,
            five_delta REAL, week_delta REAL)""")

    # -- Messung -----------------------------------------------------------------------------------
    def measure(self):
        """Frische, validierte Messung (wirft QuotaUnavailable)."""
        now = self.clock()
        try:
            raw = self.fetch()
        except QuotaUnavailable:
            raise
        except Exception as exc:
            from redact import redact
            raise QuotaUnavailable("Abfrage des Kontingents fehlgeschlagen: %s" % redact(str(exc), 200))
        snap = parse_snapshot(raw, now)
        age = now - snap["updated_at"] / 1000.0
        if age > self.cfg["max_snapshot_age_s"] or age < -60:
            raise QuotaUnavailable("Messung ist %d s alt (erlaubt: %d s)" % (age, self.cfg["max_snapshot_age_s"]))
        with self.lock:
            prev = self.db.execute("SELECT five_used, five_reset, week_used, week_reset FROM quota_log WHERE five_used IS NOT NULL ORDER BY id DESC LIMIT 1").fetchone()
        if prev:
            tol = self.cfg["monotonic_tolerance"]
            for key, (u, r) in (("five", (prev[0], prev[1])), ("week", (prev[2], prev[3]))):
                if abs(snap[key]["reset_at"] - r) < 1000 and snap[key]["used"] < u - tol:
                    raise QuotaUnavailable("Anomalie: Auslastung im Fenster '%s' ist gesunken (%.1f -> %.1f) ohne Ruecksetzung; Messung nicht vertrauenswuerdig"
                                           % (FIVE_HOUR if key == "five" else WEEK, u, snap[key]["used"]))
        return snap

    def reserve(self):
        """Sicherheitsreserve in Prozentpunkten: mindestens die Grundreserve, sonst das 1,5-fache des groessten bisher beobachteten Review-Verbrauchs."""
        with self.lock:
            row = self.db.execute("SELECT MAX(five_delta), MAX(week_delta) FROM (SELECT five_delta, week_delta FROM quota_cost ORDER BY id DESC LIMIT 20)").fetchone()
        observed = max([v for v in row if v is not None] or [0.0])
        return max(self.cfg["safety_margin_percent"], self.cfg["delta_factor"] * observed)

    def check(self):
        """Entscheidung vor JEDEM neuen Review (frische Messung, langsam: startet die OpenClaw-CLI). Nie eine Schaetzung: bei Unsicherheit allowed=False."""
        with self.check_lock:
            decision = self._check()
        with self.lock:
            self._last, self._last_ts = decision, self.clock()
        return decision

    def cached(self, max_age_s=900):
        """Schnelle Antwort fuer Chat/Status (blockiert nie): letzte Messung samt Alter; ist sie zu alt oder fehlt, wird im Hintergrund neu gemessen.
        NICHT fuer den Start eines Reviews verwenden (dort misst check() immer frisch)."""
        with self.lock:
            last, ts = self._last, self._last_ts
        age = None if ts is None else max(0, self.clock() - ts)
        if last is None or age > max_age_s:
            self.refresh_async()
        if last is None:
            return {"allowed": False, "measurable": False, "pending": True,
                    "reason": "Messung laeuft gerade (dauert bis zu 2 Minuten); bitte in einer Minute erneut fragen"}
        out = dict(last)
        out["gemessen_vor_s"] = int(age)
        out["hinweis"] = "Zwischengespeicherte Messung; ein Review misst vor dem Start immer frisch."
        return out

    def refresh_async(self):
        with self.lock:
            if self._refreshing:
                return
            self._refreshing = True

        def run():
            try:
                self.check()
            except Exception:
                pass
            finally:
                with self.lock:
                    self._refreshing = False
        threading.Thread(target=run, daemon=True).start()

    def _check(self):
        now = self.clock()
        try:
            snap = self.measure()
        except QuotaUnavailable as exc:
            self._log(now, None, False, "nicht messbar: %s" % exc)
            return {"allowed": False, "measurable": False, "reason": "Kontingent nicht zuverlaessig messbar: %s" % exc}
        reserve = self.reserve()
        limit = self.cfg["limit_percent"]
        problems = []
        for key, name in (("five", "5-Stunden"), ("week", "Wochen")):
            if snap[key]["used"] + reserve > limit:
                problems.append("%s-Fenster: %.1f %% belegt + %.1f %% Reserve > %.0f %% Grenze (Ruecksetzung %s)" % (
                    name, snap[key]["used"], reserve, limit, time.strftime("%d.%m. %H:%M", time.localtime(snap[key]["reset_at"] / 1000.0))))
        allowed = not problems
        reason = "beide Fenster unter der Grenze" if allowed else "; ".join(problems)
        self._log(now, snap, allowed, reason)
        return {"allowed": allowed, "measurable": True, "reason": reason, "reserve_percent": round(reserve, 1), "limit_percent": limit, "plan": snap["plan"],
                "five_hour": {"used_percent": snap["five"]["used"], "left_percent": round(100 - snap["five"]["used"], 1), "reset_at": snap["five"]["reset_at"]},
                "week": {"used_percent": snap["week"]["used"], "left_percent": round(100 - snap["week"]["used"], 1), "reset_at": snap["week"]["reset_at"]}}

    def record_cost(self, review_id, before, after):
        """Beobachteter Verbrauch eines Reviews (gemessen, nicht geschaetzt) fuer die Reserveberechnung."""
        if not (before and after and before.get("measurable") and after.get("measurable")):
            return
        with self.lock:
            self.db.execute("INSERT INTO quota_cost(ts, review_id, five_delta, week_delta) VALUES (?,?,?,?)", (
                self.clock(), review_id, max(0.0, after["five_hour"]["used_percent"] - before["five_hour"]["used_percent"]),
                max(0.0, after["week"]["used_percent"] - before["week"]["used_percent"])))

    def _log(self, now, snap, allowed, reason):
        with self.lock:
            self.db.execute("INSERT INTO quota_log(ts, five_used, five_reset, week_used, week_reset, plan, allowed, reason) VALUES (?,?,?,?,?,?,?,?)", (
                now, snap["five"]["used"] if snap else None, snap["five"]["reset_at"] if snap else None, snap["week"]["used"] if snap else None,
                snap["week"]["reset_at"] if snap else None, snap["plan"] if snap else None, 1 if allowed else 0, reason[:300]))
