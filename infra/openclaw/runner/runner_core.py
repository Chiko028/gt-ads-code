"""GT-Ads Coding-Runner: Kernlogik (Warteschlange, Freigabe, Limits, Stop). Nur Python-Standardbibliothek.

Grundsaetze (technisch erzwungen, nicht per Prompt):
- Nur Pakete aus der Allowlist (config "packages"); jedes Paket hat Spezifikationsdateien, aus denen ein Hash gebildet wird.
- Eine Freigabe ist an Job, Paket-ID UND Spezifikations-Hash gebunden. Aendert sich die Spezifikation, ist sie ungueltig.
- Freigabe NUR per Telegram-Schaltflaeche (approvals.py, Freigabe-Socket, Plugin gtads-freigabe); kein Code, kein Text, kein Sprachmodell.
- Hoechstens ein Job laeuft gleichzeitig; nach einem Neustart wird nichts doppelt ausgefuehrt (laufende Jobs -> "interrupted").
- Zeit-, Versuchs-, Token- und Kostenlimit werden vom Runner selbst durchgesetzt; Stop beendet den Lauf.
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import sqlite3
import threading
import time

STATES = ("prepared", "approved", "running", "plan", "succeeded", "failed", "stopped", "timeout", "budget", "interrupted", "cancelled", "locked", "expired", "blocked")
FINAL = {"succeeded", "failed", "stopped", "timeout", "budget", "interrupted", "cancelled", "locked", "expired", "blocked"}
BAD_UNIT_STATES = ("failed", "stopped", "timeout", "budget", "interrupted", "cancelled", "blocked")  # Abhaengige solcher Einheiten werden blockiert
ACTIVE = "('approved','running','plan')"
CODE_TTL_S = 900
MAX_CODE_TRIES = 3
REPORT_TEXT_MAX = 1500
DEFAULT_LIMITS = {"max_attempts": 10, "timeout_s": 3600}  # zentral; ueberschreibbar in runner.json "defaults" (Betreiber 2026-11-11: 10 Versuche, 60 min gesamt je Teilauftrag)
BALANCE_PATTERNS = ("insufficient balance", "insufficient_balance", "402")
SKIP_PATTERNS = (r"\bit\.skip\(", r"\btest\.skip\(", r"\bdescribe\.skip\(", r"\bxit\(", r"\bxdescribe\(", r"\.only\(", r"@pytest\.mark\.skip", r"\bpytest\.skip\(",
                 r"\btest\.todo\(", r"\bit\.todo\(")


from approvals import ApprovalBook, ApprovalError, buttons as approval_buttons  # noqa: E402
from redact import redact  # noqa: E402

APPROVAL_NS = "gtr"  # Telegram-Callback-Namensraum des Runners (Plugin gtads-freigabe)


class RunnerError(Exception):
    """Fachlicher Fehler mit nutzerlesbarer Meldung (ohne Geheimnisse)."""


def sha256_files(root, rel_files):
    digest = hashlib.sha256()
    for rel in sorted(rel_files):
        path = os.path.realpath(os.path.join(root, rel))
        if not path.startswith(os.path.realpath(root) + os.sep):
            raise RunnerError("Spezifikationsdatei ausserhalb des Spezifikationsverzeichnisses: %s" % rel)
        try:
            with open(path, "rb") as handle:
                data = handle.read()
        except OSError:
            raise RunnerError("Spezifikationsdatei fehlt: %s" % rel)
        digest.update(rel.encode("utf-8") + b"\0" + hashlib.sha256(data).digest())
    return digest.hexdigest()


def sha256_tree(root):
    digest = hashlib.sha256()
    for folder, dirs, files in os.walk(root):
        dirs.sort()
        for name in sorted(files):
            path = os.path.join(folder, name)
            rel = os.path.relpath(path, root)
            with open(path, "rb") as handle:
                digest.update(rel.encode("utf-8") + b"\0" + hashlib.sha256(handle.read()).digest())
    return digest.hexdigest()


EMPTY_SUITE = re.compile(r"(?im)^(no tests ran|collected 0 items|# tests 0\b|ℹ tests 0\b|Tests:\s+0 total|No test files found|no test specified)")


def empty_suite(output):
    """True, wenn die Testausgabe zeigt, dass keine Tests ausgefuehrt wurden (leere Suite gilt nie als bestanden)."""
    return bool(EMPTY_SUITE.search(output or ""))


def error_signature(output):
    """Fingerabdruck eines Testfehlers ohne Zahlen/Zeiten: gleicher Fingerabdruck = unveraenderter Fehler."""
    text = re.sub(r"\x1b\[[0-9;]*m", "", output or "")[-2000:]
    text = re.sub(r"\d+(\.\d+)?\s*(ms|s)\b", "T", text)
    text = re.sub(r"\d+", "N", text)
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:16]


def journal(job_id, message):
    """Nur lokal ins Journal (root-lesbar); lange Zeichenketten (moegliche Schluessel) unkenntlich."""
    print("Auftrag #%s: %s" % (job_id, re.sub(r"[A-Za-z0-9_-]{32,}", "<x>", str(message))[:900]), file=sys.stderr, flush=True)



def _accepts(fn, name):
    import inspect
    try:
        return name in inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False


class Store:
    def __init__(self, path):
        self.path = path
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, wp_id TEXT NOT NULL, spec_hash TEXT NOT NULL, state TEXT NOT NULL,
            created_at REAL NOT NULL, code_salt TEXT, code_hash TEXT, code_expires REAL, code_tries INTEGER NOT NULL DEFAULT 0,
            approved_at REAL, started_at REAL, finished_at REAL, attempts INTEGER NOT NULL DEFAULT 0,
            tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, stop_requested INTEGER NOT NULL DEFAULT 0,
            report TEXT, error TEXT)""")
        cols = [r["name"] for r in self.db.execute("PRAGMA table_info(jobs)").fetchall()]
        for col, ddl in (("parent_id", "INTEGER"), ("unit_id", "TEXT")):
            if col not in cols:
                self.db.execute("ALTER TABLE jobs ADD COLUMN %s %s" % (col, ddl))
        self.db.execute("""CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL, n INTEGER NOT NULL,
            ts REAL NOT NULL, phase TEXT NOT NULL, ok INTEGER NOT NULL, signature TEXT, summary TEXT)""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, job_id INTEGER, event TEXT NOT NULL, detail TEXT)""")

    def audit(self, job_id, event, detail=""):
        with self.lock:
            self.db.execute("INSERT INTO audit(ts, job_id, event, detail) VALUES (?,?,?,?)", (time.time(), job_id, event, detail[:300]))

    def one(self, sql, args=()):
        with self.lock:
            return self.db.execute(sql, args).fetchone()

    def many(self, sql, args=()):
        with self.lock:
            return self.db.execute(sql, args).fetchall()

    def run(self, sql, args=()):
        with self.lock:
            return self.db.execute(sql, args)


class Runner:
    def __init__(self, store, config, notifier, clock=time.time):
        self.store = store
        self.cfg = config
        self.notifier = notifier
        self.clock = clock
        self.approvals = ApprovalBook(config["db_path"], config.get("operator_chat_id", 0), clock)
        self.packages = config["packages"]
        self.specs_root = config["specs_root"]
        self.busy_check = None  # optional: True, solange ein Review den Workspace belegt
        self.on_success = None  # optionaler Haken (Review-Warteschlange); Fehler darin duerfen einen Auftrag nie beeintraechtigen

    # -- Hilfen ---------------------------------------------------------------------------------------
    def spec_hash(self, wp_id):
        pkg = self._package(wp_id)
        if pkg.get("release"):
            return self._load_release(wp_id)[1]
        parts = [sha256_files(self.specs_root, pkg["spec_files"])]
        if pkg.get("template_dir"):
            parts.append(sha256_tree(pkg["template_dir"]))
        eff = dict(self.limits_defaults(), **pkg)
        parts.append(json.dumps(dict({k: eff[k] for k in ("budget_usd", "timeout_s", "max_attempts", "max_tokens")}, synthetic=bool(pkg.get("synthetic", False)),
                                    units=pkg.get("units"), plan_max_tokens=pkg.get("plan_max_tokens")), sort_keys=True))  # Datenfreigabe gehoert zur Freigabe-Version
        return hashlib.sha256("|".join(parts).encode()).hexdigest()

    # -- Freigegebene Codex-Pakete (Freigabebereich: geschrieben nur vom Planer-Dienst ocplan, hier nur gelesen) -------------
    def _release_dir(self):
        d = self.cfg.get("release_dir")
        if not d:
            raise RunnerError("Kein Freigabebereich konfiguriert.")
        if os.access(d, os.W_OK):
            raise RunnerError("Freigabebereich ist fuer den Runner beschreibbar - Isolation verletzt; nichts wird gestartet.")
        return d

    def _trusted(self, path):
        st = os.stat(path)
        owner = self.cfg.get("release_owner_uid")
        if (owner is not None and st.st_uid != owner) or st.st_mode & 0o022:
            raise RunnerError("Freigabedatei %s hat unerwarteten Besitzer/Rechte; nichts wird gestartet." % os.path.basename(path))

    def released_index(self):
        d = self._release_dir()
        path = os.path.join(d, "index.json")
        if not os.path.exists(path):
            return {}
        self._trusted(path)
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)

    def _load_release(self, rid):
        """Rueckgabe (record, hash). Prueft: Index-Eintrag, Datei im Freigabebereich, Besitzer/Rechte, Hash von Inhalt == Index == Datensatz."""
        entry = self.released_index().get(rid)
        if not isinstance(entry, dict) or not re.match(r"^CX-\d{3,6}/v\d{1,4}\.json$", str(entry.get("datei", ""))):
            raise RunnerError("Paket %s ist nicht freigegeben." % str(rid)[:20])
        path = os.path.join(self._release_dir(), entry["datei"])
        self._trusted(path)
        with open(path, encoding="utf-8") as handle:
            record = json.load(handle)
        h = hashlib.sha256(json.dumps(record["paket"], sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
        if not (h == record.get("hash") == entry.get("hash")):
            raise RunnerError("Hash von %s stimmt nicht mit der Freigabe ueberein; nichts wird gestartet." % rid)
        if record.get("sensibel") and record.get("freigegeben_von") != "root":
            raise RunnerError("Sensibles Paket %s ohne root-Bestaetigung." % rid)
        return record, h

    def _register_release(self, rid):
        record, h = self._load_release(rid)
        p = record["paket"]
        rcfg = self.cfg.get("release_defaults") or {}
        test = {"cmd": p["testbefehl"], "db": True} if p.get("testbefehl") else rcfg.get("test", {"cmd": ["sh", "-c", "npm run -s typecheck && npm test -s"], "db": True})
        self.packages[rid] = {"enabled": True, "release": True, "integration": self.cfg.get("release_target", "GT-ADS-001"),
                              "budget_usd": rcfg.get("budget_usd", 2), "max_tokens": rcfg.get("max_tokens", 1000000), "spec_files": [],
                              "release_unit": {"id": rid, "title": p["titel"], "allowed_paths": p["erlaubte_pfade"], "test": test},
                              "release_task": "Arbeitspaket %s v%s: %s\nZiel: %s\nErlaubte Pfade: %s\nGeforderte Tests: %s\n\n%s" % (
                                  rid, p.get("version"), p["titel"], p["ziel"], ", ".join(p["erlaubte_pfade"]), "; ".join(p["tests"]) or "-", p["deepseek_auftrag"]),
                              "release_deps": p.get("abhaengigkeiten", []), "release_hash": h}
        return h

    def _release_ready(self, row):
        """True = startbereit; False = Abhaengigkeit laeuft/wartet noch; None = blockiert (Abhaengigkeit gescheitert oder Freigabe nicht mehr gueltig)."""
        try:
            if self._register_release(row["wp_id"]) != row["spec_hash"]:
                return None
        except RunnerError:
            return None
        for dep in self.packages[row["wp_id"]]["release_deps"]:
            last = self.store.one("SELECT state FROM jobs WHERE wp_id=? ORDER BY id DESC LIMIT 1", (dep,))
            if last is None or last["state"] in BAD_UNIT_STATES:
                return None if last is not None else False
            if last["state"] != "succeeded":
                return False
        return True

    def released(self):
        out = []
        for rid, entry in sorted(self.released_index().items()):
            last = self.store.one("SELECT id, state FROM jobs WHERE wp_id=? AND spec_hash=? ORDER BY id DESC LIMIT 1", (rid, entry.get("hash")))
            out.append({"id": rid, "version": entry.get("version"), "titel": entry.get("titel"), "hash": str(entry.get("hash"))[:12],
                        "abhaengigkeiten": entry.get("abhaengigkeiten", []), "auftrag": dict(last) if last else None})
        return out

    def start_released(self, ids=None):
        """Startet freigegebene Pakete (Freigabe = Schaltflaeche beim Planer, gebunden an genau diesen Hash). Je Version nur EIN Auftrag;
        Ausfuehrung nacheinander; Abhaengigkeiten muessen erfolgreich sein."""
        index = self.released_index()
        wanted = list(index) if not ids else [str(i) for i in ids][:20]
        started, skipped = [], []
        for rid in sorted(wanted):
            try:
                h = self._register_release(rid)
            except RunnerError as exc:
                skipped.append({"id": rid, "grund": str(exc)})
                continue
            if self.store.one("SELECT id FROM jobs WHERE wp_id=? AND spec_hash=? AND state NOT IN ('failed','stopped','timeout','interrupted','cancelled','expired','blocked','budget')", (rid, h)):
                skipped.append({"id": rid, "grund": "bereits beauftragt oder erledigt"})
                continue
            deps = self.packages[rid]["release_deps"]
            open_deps = [d for d in deps if d not in index or not self.store.one("SELECT id FROM jobs WHERE wp_id=? AND state='succeeded'", (d,))]
            if open_deps and any(d not in wanted for d in open_deps):
                skipped.append({"id": rid, "grund": "wartet auf " + ", ".join(open_deps)})
                continue
            now = self.clock()
            cur = self.store.run("INSERT INTO jobs(wp_id, spec_hash, state, created_at, approved_at, unit_id) VALUES (?,?,'approved',?,?,?)", (rid, h, now, now, rid))
            self.store.audit(cur.lastrowid, "approved_via_release", "%s %s" % (rid, h[:12]))
            started.append({"id": rid, "auftrag": cur.lastrowid})
        return {"eingereiht": started, "uebersprungen": skipped, "hinweis": "Ausfuehrung nacheinander (ein Auftrag gleichzeitig)."}

    def _package(self, wp_id):
        if isinstance(wp_id, str) and wp_id.startswith("CX-") and wp_id not in self.packages and self.cfg.get("release_dir"):
            try:
                self._register_release(wp_id)
            except RunnerError:
                pass
        if not isinstance(wp_id, str) or wp_id not in self.packages:
            raise RunnerError("Arbeitspaket '%s' ist fuer den Coding-Agenten nicht freigegeben (nicht in der Allowlist)." % str(wp_id)[:40])
        pkg = self.packages[wp_id]
        if not pkg.get("enabled", False):
            raise RunnerError("Arbeitspaket %s ist in der Runner-Konfiguration deaktiviert." % wp_id)
        return pkg

    def _job(self, job_id):
        row = self.store.one("SELECT * FROM jobs WHERE id=?", (job_id,))
        if row is None:
            raise RunnerError("Auftrag %s existiert nicht." % job_id)
        return row

    def _code_hash(self, salt, code):
        return hashlib.sha256((salt + ":" + code).encode()).hexdigest()

    # -- Befehle (von Steuerkanal/MCP) -----------------------------------------------------------------
    def prepare(self, wp_id):
        pkg = self._package(wp_id)
        if pkg.get("units"):
            self._validate_plan(pkg)  # fehlerhafte Plaene schon beim Entwurf ablehnen
        running = self.store.one("SELECT id FROM jobs WHERE state IN " + ACTIVE + " AND parent_id IS NULL")
        if running is not None:
            raise RunnerError("Es laeuft bereits ein Auftrag (#%d). Es wird nur ein Auftrag gleichzeitig bearbeitet." % running["id"])
        for old in self.store.many("SELECT id FROM jobs WHERE state='prepared'"):
            self._finish(old["id"], "cancelled", error="durch neuen Entwurf ersetzt")
        h = self.spec_hash(wp_id)
        now = self.clock()
        cur = self.store.run("INSERT INTO jobs(wp_id, spec_hash, state, created_at, code_expires) VALUES (?,?,?,?,?)",
                             (wp_id, h, "prepared", now, now + self.approvals.ttl))
        job_id = cur.lastrowid
        sensitive = bool(pkg.get("sensitive"))
        nonce = self.approvals.issue("auftrag", [("job:%d" % job_id, h)], sensitive)
        eff = dict(self.limits_defaults(), **pkg)
        text = ("Freigabe-Entwurf #%d\nArbeitspaket: %s%s\nSpezifikations-Hash: %s\nBudget: %.2f USD, max. %d Min gesamt, %d Korrekturversuche\n"
                "Freigabe NUR ueber die Schaltflaeche (einmalig, an diese Version gebunden).%s"
                % (job_id, wp_id, " (synthetisch)" if pkg.get("synthetic") else "", h[:12], pkg["budget_usd"], eff["timeout_s"] // 60, eff["max_attempts"],
                   "\nSENSIBEL: nach dem Klick zusaetzlich auf dem Server bestaetigen: sudo gtads-confirm runner job:%d" % job_id if sensitive else ""))
        try:
            self.notifier.send_operator(text, approval_buttons(APPROVAL_NS, nonce))
        except Exception:
            self.approvals.invalidate("job:%d" % job_id, "Nachricht nicht zugestellt")
            self._finish(job_id, "cancelled", error="Freigabe-Anfrage konnte nicht an den Betreiber gesendet werden")
            raise RunnerError("Die Freigabe-Anfrage konnte nicht an den Betreiber gesendet werden; Entwurf verworfen.")
        self.store.audit(job_id, "prepared", "%s %s" % (wp_id, h[:12]))
        return {"job_id": job_id, "wp_id": wp_id, "spec_hash": h[:12],
                "hinweis": "Die Freigabe-Anfrage mit Schaltflaechen ging direkt an den Betreiber. Freigeben kann nur der Betreiber per Schaltflaeche; Textnachrichten geben nichts frei."}

    # -- Freigabe per Telegram-Schaltflaeche (aufgerufen vom Gateway-Plugin ueber den Freigabe-Socket, NIE vom Sprachmodell) ---------
    def _subject_hash(self, sid):
        if sid.startswith("retry:"):
            job = self.store.one("SELECT * FROM jobs WHERE id=?", (int(sid[6:]),))
            try:
                return self.spec_hash(job["wp_id"]) if job is not None and job["state"] in FINAL else None
            except RunnerError:
                return None
        if not sid.startswith("job:"):
            return None
        job = self.store.one("SELECT * FROM jobs WHERE id=?", (int(sid[4:]),))
        if job is None or job["state"] != "prepared":
            return None
        try:
            return self.spec_hash(job["wp_id"])
        except RunnerError:
            return None

    def button(self, nonce, action, sender_id, chat_id, is_group):
        """Ergebnis fuer das Plugin: dict(text) (Text ersetzt die Nachricht; Schaltflaechen werden entfernt, ausser bei Details)."""
        try:
            if action == "d":
                info = self.approvals.details(nonce, sender_id, chat_id, is_group)
                lines = []
                for sid, h in info["subjects"]:
                    job = self.store.one("SELECT * FROM jobs WHERE id=?", (int(sid[4:]),)) if sid.startswith("job:") else None
                    if job is None:
                        continue
                    pkg = self.packages.get(job["wp_id"], {})
                    eff = dict(self.limits_defaults(), **pkg)
                    lines.append("Auftrag #%d %s: Status %s, Hash %s, Budget %.2f USD, %d Min, %d Versuche, Einheiten: %s" % (
                        job["id"], job["wp_id"], job["state"], h[:12], pkg.get("budget_usd", 0), eff["timeout_s"] // 60, eff["max_attempts"],
                        ", ".join(u["id"] for u in pkg.get("units") or []) or "-"))
                return {"text": "\n".join(lines) or "keine Details", "keep_buttons": info["state"] == "open"}
            if action == "p":  # Wiederholung: nur neuer Entwurf (mit eigener Freigabe-Anfrage), kein Start
                res = self.approvals.decide(nonce, "a", sender_id, chat_id, is_group, self._subject_hash)
                old = self._job(int(res["subjects"][0][0][6:]))
                try:
                    new = self.prepare(old["wp_id"])
                except RunnerError as exc:
                    return {"text": "Nicht vorbereitet: %s" % exc}
                return {"text": "Neuer Entwurf #%d fuer %s vorbereitet; Freigabe per Schaltflaeche in der naechsten Nachricht." % (new["job_id"], old["wp_id"])}
            if action == "a" and self.approvals.details(nonce, sender_id, chat_id, is_group)["state"] == "open" and \
                    self.store.one("SELECT id FROM jobs WHERE state IN " + ACTIVE + " AND parent_id IS NULL") is not None:
                return {"text": "Es laeuft bereits ein Auftrag; Freigabe spaeter erneut druecken.", "keep_buttons": True}
            res = self.approvals.decide(nonce, action, sender_id, chat_id, is_group, self._subject_hash)
        except ApprovalError as exc:
            return {"text": "Abgelehnt: %s" % exc, "keep_buttons": False}
        job_id = int(res["subjects"][0][0][4:])
        if res["decision"] == "rejected":
            self._finish(job_id, "cancelled", error="vom Betreiber abgelehnt")
            return {"text": "Auftrag #%d abgelehnt." % job_id}
        if res["decision"] == "strong_required":
            return {"text": "Auftrag #%d: SENSIBEL. Jetzt auf dem Server bestaetigen (30 Min): sudo gtads-confirm runner job:%d" % (job_id, job_id)}
        return {"text": "Auftrag #%d freigegeben. %s" % (job_id, self._activate(job_id)["hinweis"])}

    def resend(self, sender_id, chat_id, is_group):
        """/freigaben: offene Entwuerfe erneut mit frischen Schaltflaechen senden (alte Anfragen ungueltig). Nur Betreiber, nur privat."""
        try:
            self.approvals._check_sender(sender_id, chat_id, is_group)
        except ApprovalError as exc:
            self.approvals.log("resend_abgelehnt", sender=str(sender_id or "?"), detail=str(exc))
            return {"text": "Abgelehnt: %s" % exc}
        rows = self.store.many("SELECT * FROM jobs WHERE state='prepared' ORDER BY id")
        for row in rows:
            self.approvals.invalidate("job:%d" % row["id"], "erneut gesendet")
            pkg = self.packages.get(row["wp_id"], {})
            try:
                h = self.spec_hash(row["wp_id"])
            except RunnerError:
                continue
            if h != row["spec_hash"]:
                self._finish(row["id"], "cancelled", error="Spezifikation geaendert")
                continue
            nonce = self.approvals.issue("auftrag", [("job:%d" % row["id"], h)], bool(pkg.get("sensitive")))
            self.notifier.send_operator("Freigabe-Entwurf #%d (erneut): %s, Hash %s" % (row["id"], row["wp_id"], h[:12]), approval_buttons(APPROVAL_NS, nonce))
        return {"text": "%d Runner-Entwurf/-Entwuerfe erneut gesendet." % len(rows) if rows else "Keine Runner-Entwuerfe warten auf Freigabe."}

    def health(self):
        """/lage und Diagnose: nur lesend, bereinigt."""
        import socket
        running = self.store.one("SELECT id, wp_id, unit_id, started_at, attempts, tokens, cost_usd FROM jobs WHERE state='running' ORDER BY id DESC LIMIT 1")
        try:
            with socket.create_connection(("127.0.0.1", 3128), timeout=2):
                proxy = "erreichbar"
        except OSError:
            proxy = "NICHT erreichbar"
        failed = self.store.many("SELECT id, wp_id, unit_id, state, finished_at, error FROM jobs WHERE state IN ('failed','blocked','timeout','budget','interrupted') ORDER BY id DESC LIMIT 5")
        internal = self.store.many("SELECT ts, event, detail FROM audit WHERE event LIKE 'interner_fehler%' ORDER BY id DESC LIMIT 3")
        last_attempts = self.attempts_of(running["id"])[-3:] if running else []
        return {"dienst": "laeuft", "proxy": proxy,
                "laufender_auftrag": ({"auftrag": running["id"], "paket": running["wp_id"], "einheit": running["unit_id"], "seit_s": int(self.clock() - (running["started_at"] or self.clock())),
                                       "tokens": running["tokens"], "kosten_usd": round(running["cost_usd"], 4), "letzte_versuche": last_attempts} if running else None),
                "wartende_freigaben": self.store.one("SELECT COUNT(*) AS n FROM jobs WHERE state='prepared'")["n"],
                "letzte_fehler": [{"auftrag": r["id"], "paket": r["wp_id"], "einheit": r["unit_id"], "zustand": r["state"], "zeit": r["finished_at"], "grund": redact(r["error"], 300)} for r in failed],
                "interne_fehler": [{"zeit": r["ts"], "art": r["event"], "detail": redact(r["detail"], 200)} for r in internal]}

    def costs(self):
        rows = self.store.many("SELECT wp_id, COUNT(*) AS n, SUM(tokens) AS t, SUM(cost_usd) AS c FROM jobs GROUP BY wp_id ORDER BY c DESC")
        day = self.clock() - 86400
        last24 = self.store.one("SELECT COALESCE(SUM(cost_usd),0) AS c, COALESCE(SUM(tokens),0) AS t FROM jobs WHERE COALESCE(started_at, created_at) >= ?", (day,))
        total = sum(r["c"] or 0 for r in rows)
        return {"gesamt_usd": round(total, 4), "letzte_24h_usd": round(last24["c"], 4), "letzte_24h_tokens": last24["t"],
                "pilotbudget_usd": self.cfg.get("pilot_budget_usd", 10), "rest_pilotbudget_usd": round(self.cfg.get("pilot_budget_usd", 10) - total, 4),
                "je_paket": [{"paket": r["wp_id"], "auftraege": r["n"], "tokens": r["t"] or 0, "usd": round(r["c"] or 0, 4)} for r in rows],
                "hinweis": "DeepSeek-Kosten nach konservativen Listenpreisen aus runner.json berechnet; das Prepaid-Guthaben selbst ist nicht abfragbar."}

    def strong_confirm(self, subject, peer_uid):
        try:
            res = self.approvals.strong_confirm(subject, peer_uid, self._subject_hash)
        except ApprovalError as exc:
            raise RunnerError(str(exc))
        return self._activate(int(res["subjects"][0][0][4:]))

    def approve(self, job_id, code=None):
        raise RunnerError("Freigaben per Code/Textnachricht sind abgeschafft (Betreiber 2026-11-11). Freigabe nur per Telegram-Schaltflaeche.")

    def _activate(self, job_id):
        """Nach gepruefter Schaltflaechen-Freigabe (Hash bereits geprueft) den Auftrag einreihen."""
        job = self._job(job_id)
        if job["state"] != "prepared":
            raise RunnerError("Auftrag #%s ist nicht im Zustand 'Entwurf'." % job_id)
        current = self.spec_hash(job["wp_id"])
        if current != job["spec_hash"]:
            self._finish(job_id, "cancelled", error="Spezifikation hat sich seit dem Entwurf geaendert")
            raise RunnerError("Die Spezifikation hat sich seit dem Entwurf geaendert; Freigabe ungueltig. Bitte neu vorbereiten.")
        pkg = self.packages[job["wp_id"]]
        if pkg.get("units"):
            self.store.run("UPDATE jobs SET state='plan', approved_at=?, started_at=?, code_hash=NULL, code_salt=NULL WHERE id=? AND state='prepared'", (self.clock(), self.clock(), job_id))
            self.store.audit(job_id, "approved_plan", "%s: %d Einheiten" % (job["wp_id"], len(pkg["units"])))
            self._expand_plan(job_id, job["wp_id"], pkg)
            return {"job_id": job_id, "state": "plan", "einheiten": [u["id"] for u in pkg["units"]],
                    "hinweis": "Freigegeben. Die Unteraufgaben werden nacheinander bearbeitet (eine gleichzeitig); Fehlschlaege blockieren nur davon abhaengige Einheiten."}
        self.store.run("UPDATE jobs SET state='approved', approved_at=?, code_hash=NULL, code_salt=NULL WHERE id=? AND state='prepared'", (self.clock(), job_id))
        self.store.audit(job_id, "approved", job["wp_id"])
        return {"job_id": job_id, "state": "approved", "hinweis": "Freigegeben. Der Auftrag startet, sobald der Runner frei ist."}

    # -- Plaene (Pakete mit Unteraufgaben) ---------------------------------------------------------------
    @staticmethod
    def _validate_plan(pkg):
        ids = [u.get("id") for u in pkg["units"]]
        if not all(isinstance(i, str) and i for i in ids) or len(set(ids)) != len(ids):
            raise RunnerError("Plan ungueltig: fehlende oder doppelte Einheiten-IDs")
        seen = set()
        for unit in pkg["units"]:
            if not unit.get("prompt_file"):
                raise RunnerError("Plan ungueltig: Einheit %s ohne Auftragsdatei" % unit["id"])
            if any(dep not in seen for dep in unit.get("depends", [])):
                raise RunnerError("Plan ungueltig: Abhaengigkeit von unbekannter oder spaeterer Einheit in %s (keine Zyklen)" % unit["id"])
            seen.add(unit["id"])

    def _expand_plan(self, parent_id, wp_id, pkg):
        self._validate_plan(pkg)
        now = self.clock()
        for unit in pkg["units"]:
            self.store.run("INSERT INTO jobs(wp_id, spec_hash, state, created_at, approved_at, parent_id, unit_id) VALUES (?,?,?,?,?,?,?)",
                           (wp_id, self._job(parent_id)["spec_hash"], "approved", now, now, parent_id, unit["id"]))

    def limits_defaults(self):
        return dict(DEFAULT_LIMITS, **(self.cfg.get("defaults") or {}))

    def effective_package(self, job):
        """Paketkonfiguration, bei Einheiten mit deren Grenzen/Auftragsdatei ueberlagert (nie mit hoeheren Grenzen als erlaubt: Einheit darf nur setzen)."""
        if job["wp_id"] not in self.packages:
            self._package(job["wp_id"])  # freigegebenes Codex-Paket nach Neustart erneut aus dem Freigabebereich laden (mit Pruefung)
        pkg = dict(self.limits_defaults(), **self.packages[job["wp_id"]])
        if pkg.get("release"):
            pkg["unit"] = pkg["release_unit"]
            pkg["task_text"] = pkg["release_task"]
            return pkg
        if job["unit_id"]:
            unit = next(u for u in pkg["units"] if u["id"] == job["unit_id"])
            for key in ("timeout_s", "max_attempts", "max_tokens", "budget_usd"):
                if key in unit:
                    pkg[key] = unit[key]
            pkg["task_file"] = unit["prompt_file"]
            pkg["unit"] = unit
        return pkg

    def _plan_children(self, parent_id, latest=True):
        rows = self.store.many("SELECT id, unit_id, state, tokens, cost_usd FROM jobs WHERE parent_id=? ORDER BY id", (parent_id,))
        if not latest:
            return rows
        last = {}
        for r in rows:  # bei Neuanlauf zaehlt die neueste Zeile je Einheit
            last[r["unit_id"]] = r
        return sorted(last.values(), key=lambda r: r["id"])

    def _unit_ready(self, row):
        """True = startbereit; False = wartet; None = blockiert (Abhaengigkeit nicht erfolgreich)."""
        parent = self._job(row["parent_id"])
        unit = next(u for u in self.packages[row["wp_id"]]["units"] if u["id"] == row["unit_id"])
        states = {c["unit_id"]: c["state"] for c in self._plan_children(parent["id"])}
        if any(states.get(dep) in BAD_UNIT_STATES for dep in unit.get("depends", [])):
            return None
        return all(states.get(dep) == "succeeded" for dep in unit.get("depends", []))

    def _finalize_plan(self, parent_id):
        parent = self._job(parent_id)
        if parent["state"] != "plan":
            return
        kids = self._plan_children(parent_id)
        if any(k["state"] in ("approved", "running") for k in kids):
            return
        ok = all(k["state"] == "succeeded" for k in kids)
        units = {k["unit_id"]: k["state"] for k in kids}
        allrows = self._plan_children(parent_id, latest=False)
        tokens, cost = sum(k["tokens"] for k in allrows), sum(k["cost_usd"] for k in allrows)
        report = {"ergebnis": "succeeded" if ok else "failed", "einheiten": units, "tokens": tokens, "kosten_usd": round(cost, 4)}
        self.store.run("UPDATE jobs SET tokens=?, cost_usd=? WHERE id=?", (tokens, cost, parent_id))
        self._finish(parent_id, "succeeded" if ok else "failed", error=None if ok else "Nicht alle Einheiten erfolgreich", report=report)
        lines = ["Plan #%d (%s): %s" % (parent_id, parent["wp_id"], "ALLE Einheiten erfolgreich" if ok else "ABGESCHLOSSEN MIT FEHLERN/BLOCKADEN")]
        lines += ["  %s: %s" % (u, st) for u, st in units.items()]
        lines.append("Tokens gesamt: %d · Kosten: %.4f USD" % (tokens, cost))
        try:
            self.notifier.send_operator("\n".join(lines))
        except Exception:
            self.store.audit(parent_id, "plan_report_not_sent")

    def stop(self, job_id=None):
        row = self._job(job_id) if job_id else self.store.one("SELECT * FROM jobs WHERE state IN " + ACTIVE + " AND parent_id IS NULL ORDER BY id DESC LIMIT 1")
        if row is None:
            raise RunnerError("Es laeuft kein Auftrag.")
        if row["state"] == "plan":
            for kid in self._plan_children(row["id"]):
                if kid["state"] == "approved":
                    self._finish(kid["id"], "stopped", error="Plan durch Betreiber gestoppt")
                elif kid["state"] == "running":
                    self.store.run("UPDATE jobs SET stop_requested=1 WHERE id=?", (kid["id"],))
            self.store.audit(row["id"], "plan_stop_requested")
            self._finalize_plan(row["id"])
            return {"job_id": row["id"], "hinweis": "Plan gestoppt; eine laufende Einheit wird beendet, wartende sind abgebrochen."}
        if row["state"] in FINAL:
            raise RunnerError("Auftrag #%d ist bereits beendet (%s)." % (row["id"], row["state"]))
        self.store.run("UPDATE jobs SET stop_requested=1 WHERE id=?", (row["id"],))
        self.store.audit(row["id"], "stop_requested")
        if row["state"] in ("prepared", "approved"):
            self._finish(row["id"], "stopped", error="vor dem Start gestoppt")
        return {"job_id": row["id"], "hinweis": "Stopp angefordert."}

    def status(self):
        rows = self.store.many("SELECT id, wp_id, unit_id, state, attempts, tokens, cost_usd, started_at, finished_at FROM jobs ORDER BY id DESC LIMIT 8")
        spent = self.store.one("SELECT COALESCE(SUM(cost_usd),0) AS c FROM jobs")["c"]
        plan = self.store.one("SELECT id, wp_id, state FROM jobs WHERE parent_id IS NULL AND EXISTS (SELECT 1 FROM jobs c WHERE c.parent_id=jobs.id) ORDER BY id DESC LIMIT 1")
        plan_info = None
        if plan is not None:
            kids = self._plan_children(plan["id"])
            plan_info = {"plan_id": plan["id"], "paket": plan["wp_id"], "zustand": plan["state"], "einheiten": {k["unit_id"]: k["state"] for k in kids},
                         "tokens": sum(k["tokens"] for k in kids)}
        return {"plan": plan_info, "jobs": [dict(r) for r in rows], "gesamtkosten_usd": round(spent, 4),
                "pilotbudget_usd": self.cfg.get("pilot_budget_usd", 10), "pakete": sorted(k for k, v in self.packages.items() if v.get("enabled"))}

    def report(self, job_id=None):
        row = self._job(job_id) if job_id else self.store.one("SELECT * FROM jobs WHERE state IN %s ORDER BY id DESC LIMIT 1" % str(tuple(FINAL)))
        if row is None:
            raise RunnerError("Noch kein beendeter Auftrag.")
        return {"job_id": row["id"], "wp_id": row["wp_id"], "state": row["state"], "report": json.loads(row["report"]) if row["report"] else None, "error": row["error"],
                "versuche": self.attempts_of(row["id"])[-12:]}  # "Warum blockiert?": Grund + letzte Versuche mit Fehlersignatur

    # -- Lebenszyklus ----------------------------------------------------------------------------------
    def _finish(self, job_id, state, error=None, report=None):
        self.store.run("UPDATE jobs SET state=?, finished_at=?, error=COALESCE(?, error), report=COALESCE(?, report) WHERE id=?",
                       (state, self.clock(), error, json.dumps(report) if report is not None else None, job_id))
        self.store.audit(job_id, "finished:" + state, error or "")

    def recover_after_restart(self):
        """Nach Neustart nie automatisch weiterlaufen lassen (keine Doppelausfuehrung)."""
        for row in self.store.many("SELECT id, parent_id, unit_id, wp_id, spec_hash FROM jobs WHERE state='running'"):
            self._finish(row["id"], "interrupted", error="Dienst wurde waehrend des Laufs neu gestartet")
            if row["parent_id"] and row["unit_id"]:
                earlier = self.store.one("SELECT COUNT(*) AS n FROM jobs WHERE parent_id=? AND unit_id=? AND state='interrupted'", (row["parent_id"], row["unit_id"]))["n"]
                parent = self._job(row["parent_id"])
                if earlier <= 1 and parent["state"] == "plan":  # EIN kontrollierter Neuanlauf je Einheit: frischer Arbeitsstand aus dem Integrationsstand
                    self.store.run("INSERT INTO jobs(wp_id, spec_hash, state, created_at, approved_at, parent_id, unit_id) VALUES (?,?,?,?,?,?,?)",
                                   (row["wp_id"], row["spec_hash"], "approved", self.clock(), self.clock(), row["parent_id"], row["unit_id"]))
                    self.store.audit(row["id"], "unit_requeued_after_restart", row["unit_id"])
        for row in self.store.many("SELECT id FROM jobs WHERE state='prepared' AND code_hash IS NOT NULL"):  # Migration: alte Code-Entwuerfe
            self._finish(row["id"], "cancelled", error="Code-Freigabe abgeschafft; bitte neu vorbereiten (Freigabe per Schaltflaeche)")
        for row in self.store.many("SELECT id FROM jobs WHERE state='prepared' AND code_expires < ?", (self.clock(),)):
            self._finish(row["id"], "expired", error="Freigabe-Anfrage abgelaufen")
        for row in self.store.many("SELECT id FROM jobs WHERE state='plan'"):
            self.store.audit(row["id"], "plan_recovered", "laufende Einheit -> interrupted; Abhaengige werden blockiert, unabhaengige laufen weiter")

    def claim_next(self):
        """Atomar den naechsten startbereiten, freigegebenen Job starten, falls keiner laeuft. Einheiten warten auf ihre Abhaengigkeiten;
        scheitert eine, werden Abhaengige als 'blocked' markiert und unabhaengige Einheiten laufen weiter."""
        with self.store.lock:
            if self.store.one("SELECT id FROM jobs WHERE state='running'") is not None:
                return None
            if self.busy_check is not None and self.busy_check():
                return None
            touched = set()
            chosen = None
            for row in self.store.many("SELECT * FROM jobs WHERE state='approved' ORDER BY id"):
                if row["parent_id"] is None and str(row["wp_id"]).startswith("CX-"):
                    ready = self._release_ready(row)
                    if ready is None:
                        self._finish(row["id"], "blocked", error="blockiert: eine Abhaengigkeit ist nicht erfolgreich beendet oder die Freigabe ist ungueltig")
                        continue
                    if not ready:
                        continue
                    chosen = row
                    break
                if row["parent_id"] is None:
                    chosen = row
                    break
                parent = self._job(row["parent_id"])
                pkg = self.packages[row["wp_id"]]
                cap = pkg.get("plan_max_tokens")
                if cap is not None and sum(k["tokens"] for k in self._plan_children(parent["id"], latest=False)) >= cap:
                    self._finish(row["id"], "budget", error="Token-Gesamtlimit des Plans erreicht")
                    touched.add(parent["id"])
                    continue
                ready = self._unit_ready(row)
                if ready is None:
                    self._finish(row["id"], "blocked", error="blockiert: eine Abhaengigkeit ist nicht erfolgreich beendet")
                    touched.add(parent["id"])
                    continue
                if ready:
                    chosen = row
                    break
            result = None
            if chosen is not None:
                cur = self.store.run("UPDATE jobs SET state='running', started_at=? WHERE id=? AND state='approved'", (self.clock(), chosen["id"]))
                if cur.rowcount == 1:
                    self.store.audit(chosen["id"], "started", "%s %s" % (chosen["wp_id"], chosen["unit_id"] or ""))
                    result = self._job(chosen["id"])
            for pid in touched:
                self._finalize_plan(pid)
            if chosen is None:  # evtl. wartet nichts mehr: Plaene abschliessen
                for prow in self.store.many("SELECT id FROM jobs WHERE state='plan'"):
                    self._finalize_plan(prow["id"])
            return result

    def _log_attempt(self, job_id, n, phase, ok, signature, summary):
        self.store.run("INSERT INTO attempts(job_id, n, ts, phase, ok, signature, summary) VALUES (?,?,?,?,?,?,?)",
                       (job_id, n, self.clock(), phase, 1 if ok else 0, signature, re.sub(r"[A-Za-z0-9_-]{32,}", "<x>", summary or "")[:300]))

    def attempts_of(self, job_id):
        return [dict(r) for r in self.store.many("SELECT n, phase, ok, signature, summary, ts FROM attempts WHERE job_id=? ORDER BY id", (job_id,))]

    def _stop_plan_after(self, job):
        """Prepaid erschoepft: keine weiteren Einheiten dieses Plans starten."""
        if job["parent_id"]:
            for kid in self._plan_children(job["parent_id"]):
                if kid["state"] == "approved":
                    self._finish(kid["id"], "budget", error="Prepaid-Guthaben erschoepft - nicht gestartet")

    def stop_requested(self, job_id):
        return bool(self._job(job_id)["stop_requested"])

    def add_usage(self, job_id, tokens, cost_usd):
        self.store.run("UPDATE jobs SET tokens=tokens+?, cost_usd=cost_usd+? WHERE id=?", (int(tokens), float(cost_usd), job_id))

    def cost_of(self, usage):
        price = self.cfg.get("price_usd_per_million_tokens", {"input": 0.0, "output": 0.0})
        return (usage.get("input_tokens", 0) * price["input"] + usage.get("output_tokens", 0) * price["output"]) / 1e6

    def execute(self, job, executor):
        """Fuehrt einen beanspruchten Job aus. Alle Limits werden HIER durchgesetzt."""
        pkg = self.effective_package(job)
        job_id = job["id"]
        started = self.clock()
        deadline = started + pkg["timeout_s"]
        notes, tests, final_state, error, snapshot = [], None, "failed", None, None

        def limit_hit():
            if self.stop_requested(job_id):
                return "stopped"
            if self.clock() >= deadline:
                return "timeout"
            row = self._job(job_id)
            if row["tokens"] >= pkg["max_tokens"] or row["cost_usd"] >= pkg["budget_usd"]:
                return "budget"
            pilot = self.store.one("SELECT COALESCE(SUM(cost_usd),0) AS c FROM jobs")["c"]
            if pilot >= self.cfg.get("pilot_budget_usd", 10):
                return "budget"
            return None

        try:
            executor.prepare_workspace(job, pkg)
            baseline = executor.test_baseline() if hasattr(executor, "test_baseline") else None
            prompt = executor.build_prompt(job, pkg, correction=None)
            state_now, last_sig, same_count, idle_count = None, None, 0, 0
            for attempt in range(pkg["max_attempts"] + 1):
                state_now = limit_hit()
                if state_now:
                    break
                before = executor.fingerprint() if hasattr(executor, "fingerprint") else None
                turn = executor.agent_turn(job, prompt, max(1, int(deadline - self.clock())))
                self.add_usage(job_id, turn.get("input_tokens", 0) + turn.get("output_tokens", 0), self.cost_of(turn))
                if turn.get("text"):
                    notes.append(str(turn["text"])[:REPORT_TEXT_MAX])
                self.store.run("UPDATE jobs SET attempts=? WHERE id=?", (attempt, job_id))
                if turn.get("exit_code", 0) != 0:  # Agent-Aufruf gescheitert: keine Tests, kein weiterer Versuch (Infrastruktur, nicht Code)
                    msg = (turn.get("error") or "Agent-Aufruf fehlgeschlagen (Exit %s)" % turn.get("exit_code"))[:300]
                    self._log_attempt(job_id, attempt, "agent", False, None, msg)
                    journal(job_id, "Agent-Aufruf fehlgeschlagen: " + msg)
                    if any(p in msg.lower() for p in BALANCE_PATTERNS):
                        final_state, error = "budget", "Prepaid-Guthaben erschoepft oder Zahlung erforderlich: " + msg
                        self._stop_plan_after(job)
                    else:
                        final_state, error = "failed", "Agent-Aufruf fehlgeschlagen: " + msg
                    break
                state_now = limit_hit()
                if state_now:
                    break
                if baseline is not None:
                    weakened = executor.test_integrity(baseline)
                    if weakened:  # Tests geloescht/uebersprungen: sofortiger Stopp, nie als Erfolg werten
                        self._log_attempt(job_id, attempt, "integritaet", False, None, weakened)
                        final_state, error = "blocked", "Tests abgeschwaecht (" + weakened + ") - Auftrag gestoppt"
                        break
                if before is not None and executor.fingerprint() == before:
                    idle_count += 1
                    if idle_count >= 2:
                        self._log_attempt(job_id, attempt, "agent", False, None, "keine Aenderung im Arbeitsstand")
                        final_state, error = "blocked", "Zwei wirkungslose Versuche nacheinander (keine Aenderung) - blockiert"
                        break
                else:
                    idle_count = 0
                tests = executor.run_tests(job, max(1, int(deadline - self.clock())))
                if tests.get("fatal"):  # Sicherheitsregel verletzt (z. B. Paket ausserhalb der Versorgung): sofortiger Stopp
                    self._log_attempt(job_id, attempt, "sicherheit", False, None, tests["fatal"][:300])
                    final_state, error = "blocked", "Sicherheitsregel verletzt: " + tests["fatal"][:300]
                    break
                if empty_suite(tests.get("output")):  # Betreiber 2026-11-11 (WP-009): leere Testsuite ist ein Fehler, kein Erfolg
                    tests = dict(tests, passed=False, output="LEERE TESTSUITE: Es wurden keine Tests ausgefuehrt. Lege die geforderten Tests an "
                                 "(Dateien/Namen gemaess Auftrag), damit der Testbefehl sie findet.\n" + (tests.get("output") or "")[-3000:])
                sig = None if tests["passed"] else error_signature(tests.get("output"))
                self._log_attempt(job_id, attempt, "tests", tests["passed"], sig, (tests.get("output") or "")[-300:])
                if tests["passed"]:
                    final_state = "succeeded"
                    break
                if attempt >= pkg["max_attempts"]:
                    final_state, error = "blocked", "Tests nach %d Korrekturversuchen weiter fehlgeschlagen - blockiert" % pkg["max_attempts"]
                    break
                same_count = same_count + 1 if sig == last_sig else 0
                last_sig = sig
                analyse = same_count >= 1  # derselbe Fehler zweimal in Folge -> erst Ursachenanalyse
                prompt = executor.build_prompt(job, pkg, correction=tests["output"][-2000:], analyse=analyse, attempt=attempt + 1, limit=pkg["max_attempts"]) \
                    if _accepts(executor.build_prompt, "analyse") else executor.build_prompt(job, pkg, correction=tests["output"][-2000:])
            if state_now:
                final_state, error = state_now, {"stopped": "durch Betreiber gestoppt", "timeout": "Laufzeitlimit erreicht", "budget": "Token-/Kostenlimit erreicht"}[state_now]
            commit = executor.commit(job)
            if final_state == "succeeded" and job["unit_id"] and hasattr(executor, "accept"):
                accepted = executor.accept(job)  # Ergebnis in den gemeinsamen Integrationsstand uebernehmen (nur nach bestandenen Tests)
                if not accepted:
                    reason = getattr(executor, "last_accept", None) or "unbekannt"
                    final_state = "blocked" if "Unerlaubte Pfade" in reason else "failed"
                    error = "Uebernahme in den Integrationsstand abgelehnt: " + reason[:300]
            if final_state == "succeeded" and self.on_success is not None and not job["unit_id"] and hasattr(executor, "snapshot"):
                try:
                    snapshot = executor.snapshot(job)
                except Exception:
                    snapshot = None
        except Exception as exc:  # Fehler nie mit Details/Geheimnissen nach aussen (Telegram) weiterreichen ...
            final_state, error, commit = "failed", "Interner Fehler: %s" % exc.__class__.__name__, None
            # ... aber fuer die Fehlersuche ins Journal (nur lokal, root-lesbar), lange Zeichenketten unkenntlich gemacht
            import re as _re
            import sys as _sys
            print("Auftrag #%s: %s: %s" % (job_id, exc.__class__.__name__, _re.sub(r"[A-Za-z0-9_-]{32,}", "<x>", str(exc))[:800]), file=_sys.stderr, flush=True)
        finally:
            try:
                executor.cleanup(job)
            except Exception:
                pass
        row = self._job(job_id)
        report = {"ergebnis": final_state, "tests": tests, "korrekturversuche": row["attempts"], "dauer_s": int(self.clock() - started),
                  "tokens": row["tokens"], "kosten_usd": round(row["cost_usd"], 4), "commit": commit,
                  "agent_notiz_ungeprueft": notes[-1] if notes else None, "fehler": error}
        self._finish(job_id, final_state, error=error, report=report)
        if snapshot is not None and self.on_success is not None:
            try:
                self.on_success(job_id, snapshot)
            except Exception:
                self.store.audit(job_id, "review_enqueue_failed")
        retry = None
        if final_state != "succeeded" and not job["parent_id"] and not str(job["wp_id"]).startswith("CX-"):
            try:  # [Erneut vorbereiten]: erzeugt nur einen NEUEN Entwurf; gestartet wird erst nach erneuter Freigabe
                n = self.approvals.issue("wiederholung", [("retry:%d" % job_id, job["spec_hash"])])
                retry = [[{"text": "Erneut vorbereiten", "callback_data": "%s:p:%s" % (APPROVAL_NS, n)}]]
            except Exception:
                retry = None
        try:
            self.notifier.send_operator(self.format_report(job_id, report, job["unit_id"]), retry)
        except Exception:
            self.store.audit(job_id, "report_not_sent")
        if job["parent_id"]:
            self._finalize_plan(job["parent_id"])  # Zusammenfassung des Plans NACH dem Bericht der letzten Einheit
        return report

    @staticmethod
    def format_report(job_id, r, unit=None):
        tests = r.get("tests") or {}
        lines = ["Bericht Auftrag #%d%s: %s" % (job_id, (" Einheit " + unit) if unit else "", r["ergebnis"].upper()),
                 "Tests: %s" % ("bestanden" if tests.get("passed") else "NICHT bestanden" if tests else "nicht ausgefuehrt"),
                 "Korrekturversuche: %d · Dauer: %d s · Tokens: %d · Kosten: %.4f USD" % (r["korrekturversuche"], r["dauer_s"], r["tokens"], r["kosten_usd"]),
                 "Commit: %s" % (r.get("commit") or "keiner")]
        if r.get("fehler"):
            lines.append("Hinweis: %s" % r["fehler"])
        if r.get("agent_notiz_ungeprueft"):
            lines.append("Notiz des Agenten (ungeprueft, kann falsch sein): %s" % r["agent_notiz_ungeprueft"][:600])
        return "\n".join(lines)[:3500]
