"""Bereinigt Texte fuer Telegram/Protokolle: keine Schluessel, Token, E-Mail-Adressen, Device-Codes, lange Zufallsfolgen."""

import re

PATTERNS = [
    (re.compile(r"AIza[0-9A-Za-z_\-]{30,}"), "<schluessel>"),
    (re.compile(r"\bsk-[A-Za-z0-9_\-]{2,}"), "<schluessel>"),  # auch kurze/abgeschnittene Schluessel
    (re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{30,}"), "<bot-token>"),
    (re.compile(r"(?i)\b(bearer|token|authorization|api[_-]?key|password|passwort|secret|cookie)\b(\s*[:=]\s*|\s+)['\"]?[^\s'\",}]{6,}"), r"\1=<entfernt>"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)"), "<privater-schluessel>"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"), "<github-token>"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"), "<jwt>"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "<e-mail>"),
    (re.compile(r"\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b"), "<code>"),
    (re.compile(r"[A-Za-z0-9_\-+=]{40,}"), "<lang>"),  # ohne "/": Pfade bleiben lesbar
]


def redact(text, limit=600):
    text = str(text or "")
    for pat, repl in PATTERNS:
        text = pat.sub(repl, text)
    return text[-limit:] if limit else text
