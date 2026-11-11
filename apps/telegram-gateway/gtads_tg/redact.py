"""Redaktion von Geheimnissen und Metadaten-Logging (AC-07, AC-08).

Logs enthalten ausschließlich Metadaten. Nachrichteninhalte, Antworten, Token und Schlüssel dürfen
nie in Logs, Fehlermeldungen oder Statusausgaben erscheinen.
"""

import logging
import re

_PATTERNS = [
    (re.compile(r"bot\d{5,}:[A-Za-z0-9_-]{20,}"), "bot<REDACTED>"),
    (re.compile(r"\b\d{5,}:[A-Za-z0-9_-]{30,}\b"), "<REDACTED-TOKEN>"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{12,}\b"), "<REDACTED-KEY>"),
    (re.compile(r"(?i)authorization\s*[:=]\s*(?:bearer\s+)?\S+"), "Authorization: <REDACTED>"),
    (re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{8,}"), "Bearer <REDACTED>"),
]

_known_secrets = set()


def register_secret(value):
    """Registriert einen geheimen Wert, der in jeder Ausgabe wörtlich ersetzt wird."""
    if isinstance(value, str) and len(value) >= 8:
        _known_secrets.add(value)


def clear_secrets():
    _known_secrets.clear()


def redact(text):
    """Ersetzt bekannte Geheimnisse und Token-/Schlüsselmuster."""
    if not isinstance(text, str):
        text = str(text)
    for secret in _known_secrets:
        text = text.replace(secret, "<REDACTED>")
    for pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)
    return text


class RedactingFormatter(logging.Formatter):
    """Formatter, der Nachricht und Exception-Text redigiert."""

    def format(self, record):
        return redact(super().format(record))


# Erlaubte Metadaten-Schlüssel und ihre Wertform (nie Freitext aus Nachrichten).
_ALLOWED_META = {"len", "n", "status", "class", "reason", "id", "version"}
_SAFE_VALUE = re.compile(r"^[A-Za-z0-9_.:-]{0,40}$")


def log_event(logger, event, result, **meta):
    """Schreibt eine Metadaten-Zeile: `<event> <result> key=value ...`.

    Unbekannte Schlüssel oder unsichere Werte werden verworfen, damit nie Inhalte ins Log gelangen.
    """
    parts = [str(event), str(result)]
    for key in sorted(meta):
        value = meta[key]
        if key not in _ALLOWED_META:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, str)):
            continue
        text = str(value)
        if not _SAFE_VALUE.match(text):
            continue
        parts.append("%s=%s" % (key, text))
    logger.info(" ".join(parts))
