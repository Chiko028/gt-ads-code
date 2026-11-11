"""Deterministische Freigabekomponente fuer Telegram-Schaltflaechen (ohne Sprachmodell, nur Python-Standardbibliothek).

Betreiberentscheidung 2026-11-11:
- Freigabe nur per Inline-Schaltflaeche im PRIVATEN Chat des Betreibers; normale Nachrichten loesen nie eine Freigabe aus.
- Die Telegram-Benutzer-ID wird serverseitig geprueft (sie stammt aus dem vom Gateway empfangenen Callback, nicht aus Text).
- Jede Anfrage ist an Gegenstand-ID + Spezifikations-Hash gebunden, zufaellig (128 Bit), EINMALIG und befristet.
  Gespeichert wird nur der SHA-256 der Nonce; Wiederholung, Ablauf und geaenderte Spezifikation werden abgelehnt.
- Sensible Gegenstaende (Deployments, Rechte, Infrastruktur) brauchen zusaetzlich eine Bestaetigung auf dem Server durch root
  (SSH-Schluessel + sudo-Passwort = unabhaengiger Faktor; der Besitz des Telegram-Kontos allein reicht nicht).
- Alles wird protokolliert (ohne Nonce im Klartext).
Grenze: Die Absender-ID liefert das OpenClaw-Gateway aus dem Telegram-Update. Wer das Gateway (Benutzer openclaw) kompromittiert,
kann Callbacks faelschen; deshalb gibt es fuer sensible Aktionen die root-Bestaetigung auf dem Server.
"""

import hashlib
import json
import re
import secrets
import sqlite3
import threading
import time

NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{22}$")
DEFAULT_TTL_S = 24 * 3600          # Freigabeanfragen verfallen nach 24 h (danach neu anfordern)
STRONG_TTL_S = 30 * 60             # Fenster fuer die root-Bestaetigung nach dem Klick
ACTIONS = {"a": "freigeben", "r": "ablehnen", "d": "details"}


class ApprovalError(Exception):
    """Ablehnung mit nutzerlesbarem Grund (ohne Geheimnisse)."""


def _h(nonce):
    return hashlib.sha256(nonce.encode("ascii")).hexdigest()


class ApprovalBook:
    def __init__(self, db_path, operator_id, clock=time.time, ttl_s=DEFAULT_TTL_S):
        self.operator = str(int(operator_id))
        self.clock, self.ttl = clock, ttl_s
        self.lock = threading.RLock()
        self.db = sqlite3.connect(db_path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS approval_requests (nonce_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, subjects TEXT NOT NULL,
            sensitive INTEGER NOT NULL, created REAL NOT NULL, expires REAL NOT NULL, state TEXT NOT NULL, decided_at REAL, decision TEXT,
            sender TEXT, strong_until REAL)""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS approval_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, event TEXT NOT NULL,
            subjects TEXT, sender TEXT, detail TEXT)""")

    # -- Protokoll ------------------------------------------------------------------------------------------
    def log(self, event, subjects=None, sender=None, detail=""):
        with self.lock:
            self.db.execute("INSERT INTO approval_log(ts, event, subjects, sender, detail) VALUES (?,?,?,?,?)",
                            (self.clock(), event, json.dumps(subjects) if subjects is not None else None, sender, str(detail)[:300]))

    def history(self, limit=50):
        with self.lock:
            return [dict(r) for r in self.db.execute("SELECT ts, event, subjects, sender, detail FROM approval_log ORDER BY id DESC LIMIT ?", (limit,))]

    # -- Anfragen ------------------------------------------------------------------------------------------
    def issue(self, kind, subjects, sensitive=False):
        """subjects: Liste [(id, hash)]. Rueckgabe: Nonce (nur fuer die Schaltflaeche; nie loggen/speichern)."""
        subjects = [[str(i), str(h)] for i, h in subjects]
        if not subjects:
            raise ApprovalError("nichts freizugeben")
        nonce = secrets.token_urlsafe(16)
        now = self.clock()
        with self.lock:
            self.db.execute("INSERT INTO approval_requests(nonce_hash, kind, subjects, sensitive, created, expires, state) VALUES (?,?,?,?,?,?, 'open')",
                            (_h(nonce), kind, json.dumps(subjects), 1 if sensitive else 0, now, now + self.ttl))
        self.log("angefordert", subjects, detail="%s%s" % (kind, " sensibel" if sensitive else ""))
        return nonce

    def invalidate(self, subject_id, reason="Spezifikation geaendert"):
        """Alle offenen Anfragen, die diesen Gegenstand enthalten, ungueltig machen (z. B. neue Version)."""
        n = 0
        with self.lock:
            for row in self.db.execute("SELECT nonce_hash, subjects FROM approval_requests WHERE state IN ('open','strong')").fetchall():
                if any(s[0] == str(subject_id) for s in json.loads(row["subjects"])):
                    self.db.execute("UPDATE approval_requests SET state='invalid', decision=? WHERE nonce_hash=?", (reason[:80], row["nonce_hash"]))
                    n += 1
        if n:
            self.log("ungueltig", [[str(subject_id), ""]], detail=reason)
        return n

    def _check_sender(self, sender_id, chat_id, is_group):
        sender, chat = str(sender_id or ""), str(chat_id or "")
        if sender != self.operator:
            raise ApprovalError("nicht autorisierter Absender")
        if is_group or chat != self.operator:
            raise ApprovalError("Freigaben nur im privaten Chat des Betreibers")
        return sender

    def _load(self, nonce):
        if not isinstance(nonce, str) or not NONCE_RE.match(nonce):
            raise ApprovalError("ungueltige Anfrage")
        row = self.db.execute("SELECT * FROM approval_requests WHERE nonce_hash=?", (_h(nonce),)).fetchone()
        if row is None:
            raise ApprovalError("unbekannte Anfrage")
        return row

    def details(self, nonce, sender_id, chat_id, is_group):
        """Nur lesen (verbraucht nichts). Rueckgabe: dict(kind, subjects, state, sensitive)."""
        with self.lock:
            try:
                sender = self._check_sender(sender_id, chat_id, is_group)
                row = self._load(nonce)
            except ApprovalError as exc:
                self.log("details_abgelehnt", sender=str(sender_id or "?"), detail=str(exc))
                raise
        return {"kind": row["kind"], "subjects": json.loads(row["subjects"]), "state": row["state"], "sensitive": bool(row["sensitive"]), "sender": sender}

    def decide(self, nonce, action, sender_id, chat_id, is_group, current_hash):
        """action 'a' (freigeben) oder 'r' (ablehnen). current_hash(id) -> aktueller Hash oder None.
        Rueckgabe: dict(decision='approved'|'rejected'|'strong_required', subjects=[...]). Wirft ApprovalError."""
        if action not in ("a", "r"):
            raise ApprovalError("unbekannte Aktion")
        with self.lock:
            try:
                sender = self._check_sender(sender_id, chat_id, is_group)
                row = self._load(nonce)
                subjects = json.loads(row["subjects"])
                if row["state"] != "open":
                    raise ApprovalError("bereits verwendet oder ungueltig (%s)" % row["state"])
                now = self.clock()
                if now > row["expires"]:
                    self.db.execute("UPDATE approval_requests SET state='expired' WHERE nonce_hash=?", (row["nonce_hash"],))
                    raise ApprovalError("Anfrage abgelaufen; bitte neu anfordern")
                if True:  # auch Ablehnen nur fuer den aktuellen Stand (verhindert Abbruch laufender/ersetzter Auftraege per altem Knopf)
                    for sid, h in subjects:
                        if current_hash(sid) != h:
                            self.db.execute("UPDATE approval_requests SET state='invalid', decision='Spezifikation geaendert' WHERE nonce_hash=?", (row["nonce_hash"],))
                            raise ApprovalError("%s ist in dieser Version nicht mehr offen (geaendert, ersetzt oder beendet); Anfrage ungueltig" % sid)
                new_state = "strong" if (action == "a" and row["sensitive"]) else "used"
                decision = {"a": "approved", "r": "rejected"}[action] if new_state == "used" else "strong_required"
                cur = self.db.execute("UPDATE approval_requests SET state=?, decided_at=?, decision=?, sender=?, strong_until=? WHERE nonce_hash=? AND state='open'",
                                      (new_state, now, decision, sender, now + STRONG_TTL_S if new_state == "strong" else None, row["nonce_hash"]))
                if cur.rowcount != 1:
                    raise ApprovalError("bereits verwendet")
            except ApprovalError as exc:
                self.log("abgelehnt", sender=str(sender_id or "?"), detail="%s: %s" % (ACTIONS.get(action, "?"), exc))
                raise
        self.log({"approved": "freigegeben", "rejected": "abgelehnt_durch_betreiber", "strong_required": "wartet_auf_root"}[decision], subjects, sender)
        return {"decision": decision, "subjects": subjects}

    def strong_pending(self):
        with self.lock:
            rows = self.db.execute("SELECT subjects, strong_until FROM approval_requests WHERE state='strong' AND strong_until>?", (self.clock(),)).fetchall()
        return [{"subjects": json.loads(r["subjects"]), "gueltig_bis": r["strong_until"]} for r in rows]

    def strong_confirm(self, subject_id, peer_uid, current_hash):
        """Zweiter Faktor fuer sensible Gegenstaende: nur root (peer_uid 0, per SO_PEERCRED vom Socket) nach dem Telegram-Klick."""
        if peer_uid != 0:
            self.log("root_bestaetigung_abgelehnt", [[str(subject_id), ""]], detail="peer uid %s" % peer_uid)
            raise ApprovalError("Bestaetigung nur durch root auf dem Server")
        with self.lock:
            now = self.clock()
            for row in self.db.execute("SELECT * FROM approval_requests WHERE state='strong'").fetchall():
                subjects = json.loads(row["subjects"])
                if not any(s[0] == str(subject_id) for s in subjects):
                    continue
                if now > row["strong_until"]:
                    self.db.execute("UPDATE approval_requests SET state='expired' WHERE nonce_hash=?", (row["nonce_hash"],))
                    continue
                if any(current_hash(sid) != h for sid, h in subjects):
                    self.db.execute("UPDATE approval_requests SET state='invalid' WHERE nonce_hash=?", (row["nonce_hash"],))
                    raise ApprovalError("Spezifikation geaendert; Freigabe ungueltig")
                cur = self.db.execute("UPDATE approval_requests SET state='used', decision='approved' WHERE nonce_hash=? AND state='strong'", (row["nonce_hash"],))
                if cur.rowcount == 1:
                    self.log("freigegeben_root_bestaetigt", subjects, "root")
                    return {"decision": "approved", "subjects": subjects}
        raise ApprovalError("keine wartende Telegram-Freigabe fuer %s (zuerst in Telegram freigeben; Fenster %d Min)" % (subject_id, STRONG_TTL_S // 60))


def buttons(ns, nonce, batch_label=None):
    """Inline-Tastatur fuer Telegram (callback_data <= 64 Byte)."""
    if batch_label:
        return [[{"text": batch_label, "callback_data": "%s:a:%s" % (ns, nonce)}], [{"text": "Alle ablehnen", "callback_data": "%s:r:%s" % (ns, nonce)}]]
    return [[{"text": "Freigeben", "callback_data": "%s:a:%s" % (ns, nonce)}, {"text": "Ablehnen", "callback_data": "%s:r:%s" % (ns, nonce)},
             {"text": "Details", "callback_data": "%s:d:%s" % (ns, nonce)}]]
