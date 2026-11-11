"""Gemini als optionaler, BERATENDER Zusatz-Reviewer (nur Python-Standardbibliothek).

Betreiberentscheidung (2026-11-10): Gemini bekommt ausschliesslich SYNTHETISCHE Beispiele, nie GT-Ads-Code; nur kostenloser API-Tarif.
Technisch erzwungen:
- nur Pakete mit "synthetic": true in der Runner-Konfiguration (Pruefung in review_core, nicht hier umgehbar);
- Secret-Scan des Prompts (bei Treffer: nichts wird gesendet);
- eigenes, persistentes Anfragebudget (der kostenlose Tarif meldet kein abfragbares Kontingent): Tageslimit nach Pazifik-Zeit,
  Mindestabstand, Prompt-Groesse; HTTP 429 sperrt bis zur naechsten Rueckstellung; 401/403 deaktiviert Gemini dauerhaft;
- der API-Schluessel steht nur in der systemd-Credential-Datei, wird per Header gesendet (nie in URL/Log/Bericht);
- nur ueber den Egress-Proxy, nur Host generativelanguage.googleapis.com.
Grenze: Ob das Google-Projekt ohne Abrechnungskonto laeuft (= kostenloser Tarif), laesst sich aus dem Schluessel NICHT ablesen. Das muss der Betreiber sicherstellen.
"""

import http.client
import json
import re
import sqlite3
import threading
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

HOST = "generativelanguage.googleapis.com"
PACIFIC = ZoneInfo("America/Los_Angeles")
SECRET_PATTERNS = [re.compile(p) for p in (
    r"AIza[0-9A-Za-z_\-]{30,}", r"\bsk-[A-Za-z0-9]{20,}", r"-----BEGIN [A-Z ]*PRIVATE KEY-----", r"\b\d{8,10}:[A-Za-z0-9_-]{30,}",
    r"\bAKIA[0-9A-Z]{16}\b", r"(?i)\b(password|passwort|secret|api[_-]?key|token)\s*[:=]\s*['\"][^'\"\s]{8,}['\"]", r"\bghp_[A-Za-z0-9]{30,}", r"\bxox[baprs]-[A-Za-z0-9-]{10,}")]
DEFAULTS = {"max_requests_per_day": 10, "min_interval_s": 15, "max_prompt_chars": 60000, "timeout_s": 90, "max_response_bytes": 400000}


class GeminiUnavailable(Exception):
    """Gemini darf/kann jetzt nicht genutzt werden (Text ohne Geheimnisse)."""


def contains_secret(text):
    return any(p.search(text) for p in SECRET_PATTERNS)


def next_pacific_midnight(now):
    local = datetime.fromtimestamp(now, PACIFIC)
    nxt = (local + timedelta(days=1)).replace(hour=0, minute=5, second=0, microsecond=0)  # 5 Minuten Toleranz nach der Rueckstellung
    return nxt.timestamp()


def pacific_day(now):
    return datetime.fromtimestamp(now, PACIFIC).strftime("%Y-%m-%d")


class GeminiLimiter:
    def __init__(self, db_path, cfg=None, clock=time.time):
        self.cfg = dict(DEFAULTS, **(cfg or {}))
        self.clock = clock
        self.lock = threading.RLock()
        self.db = sqlite3.connect(db_path, check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS gemini_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, day TEXT NOT NULL, outcome TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS gemini_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)")

    def _get(self, key):
        with self.lock:
            row = self.db.execute("SELECT v FROM gemini_state WHERE k=?", (key,)).fetchone()
        return row[0] if row else None

    def _set(self, key, value):
        with self.lock:
            self.db.execute("INSERT INTO gemini_state(k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (key, str(value)))

    def status(self):
        now = self.clock()
        with self.lock:
            used = self.db.execute("SELECT COUNT(*) FROM gemini_calls WHERE day=?", (pacific_day(now),)).fetchone()[0]
            last = self.db.execute("SELECT MAX(ts) FROM gemini_calls").fetchone()[0]
        disabled = self._get("disabled")
        blocked_until = float(self._get("blocked_until") or 0)
        return {"heute_genutzt": used, "tageslimit": self.cfg["max_requests_per_day"], "letzte_anfrage": last, "dauerhaft_deaktiviert": disabled,
                "gesperrt_bis": blocked_until if blocked_until > now else None}

    def check(self):
        """Wirft GeminiUnavailable, wenn eine Anfrage jetzt nicht erlaubt ist."""
        now = self.clock()
        st = self.status()
        if st["dauerhaft_deaktiviert"]:
            raise GeminiUnavailable("Gemini dauerhaft deaktiviert: %s" % st["dauerhaft_deaktiviert"])
        if st["gesperrt_bis"]:
            raise GeminiUnavailable("Gemini pausiert (Limit/Fehler) bis %s" % time.strftime("%d.%m. %H:%M", time.localtime(st["gesperrt_bis"])))
        if st["heute_genutzt"] >= self.cfg["max_requests_per_day"]:
            raise GeminiUnavailable("Eigenes Tageslimit erreicht (%d/%d Anfragen)" % (st["heute_genutzt"], self.cfg["max_requests_per_day"]))
        if st["letzte_anfrage"] and now - st["letzte_anfrage"] < self.cfg["min_interval_s"]:
            raise GeminiUnavailable("Mindestabstand zwischen Anfragen noch nicht erreicht")

    def record(self, outcome):
        now = self.clock()
        with self.lock:
            self.db.execute("INSERT INTO gemini_calls(ts, day, outcome) VALUES (?,?,?)", (now, pacific_day(now), outcome))

    def block_until(self, ts):
        self._set("blocked_until", ts)

    def disable(self, reason):
        self._set("disabled", reason)


def default_transport(proxy, timeout):
    def send(path, headers, body):
        conn = http.client.HTTPSConnection(proxy[0], proxy[1], timeout=timeout)
        conn.set_tunnel(HOST, 443)
        try:
            conn.request("POST", path, body=body, headers=headers)
            resp = conn.getresponse()
            return resp.status, resp.read(400001)
        finally:
            conn.close()
    return send


class GeminiReviewer:
    """review(prompt) -> Text des Modells. Wirft GeminiUnavailable bei jeder Sperre/jedem Fehler (Gemini ist optional)."""

    def __init__(self, api_key, model, limiter, cfg=None, transport=None, proxy=("127.0.0.1", 3128), clock=time.time):
        self.key = (api_key or "").strip()
        self.model = model
        self.limiter = limiter
        self.cfg = dict(DEFAULTS, **(cfg or {}))
        self.transport = transport or default_transport(proxy, self.cfg["timeout_s"])
        self.clock = clock

    @property
    def configured(self):
        return bool(self.key and self.model)

    def review(self, prompt):
        if not self.configured:
            raise GeminiUnavailable("Gemini nicht eingerichtet (Schluessel oder Modell fehlt)")
        if len(prompt) > self.cfg["max_prompt_chars"]:
            raise GeminiUnavailable("Prompt zu gross fuer den kostenlosen Tarif (> %d Zeichen)" % self.cfg["max_prompt_chars"])
        if contains_secret(prompt):
            raise GeminiUnavailable("Prompt enthaelt etwas, das wie ein Geheimnis aussieht; nichts gesendet")
        self.limiter.check()
        body = json.dumps({"contents": [{"role": "user", "parts": [{"text": prompt}]}], "generationConfig": {"temperature": 0.1, "maxOutputTokens": 4096}}).encode("utf-8")
        headers = {"Content-Type": "application/json", "x-goog-api-key": self.key}
        path = "/v1beta/models/%s:generateContent" % self.model
        self.limiter.record("gesendet")  # vor dem Senden zaehlen: ein Absturz darf nie zu Mehrfachanfragen fuehren
        try:
            status, data = self.transport(path, headers, body)
        except Exception:
            self.limiter.block_until(self.clock() + 3600)
            raise GeminiUnavailable("Verbindung zu Gemini fehlgeschlagen; 1 Stunde Pause")
        if status == 429:
            until = next_pacific_midnight(self.clock())
            self.limiter.block_until(until)
            raise GeminiUnavailable("Gemini meldet Limit erreicht (HTTP 429); Pause bis zur naechsten Rueckstellung")
        if status in (401, 403):
            self.limiter.disable("Zugriff verweigert (HTTP %d): Schluessel pruefen" % status)
            raise GeminiUnavailable("Gemini verweigert den Zugriff (HTTP %d); dauerhaft deaktiviert" % status)
        if status != 200 or len(data) > self.cfg["max_response_bytes"]:
            self.limiter.block_until(self.clock() + 3600)
            raise GeminiUnavailable("Unerwartete Antwort von Gemini (HTTP %d); 1 Stunde Pause" % status)
        try:
            parts = json.loads(data.decode("utf-8"))["candidates"][0]["content"]["parts"]
            return "".join(p.get("text", "") for p in parts if isinstance(p, dict))
        except (ValueError, KeyError, IndexError, TypeError):
            raise GeminiUnavailable("Antwort von Gemini nicht lesbar")
