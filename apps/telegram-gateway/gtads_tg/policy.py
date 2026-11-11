"""Absender- und Update-Policy, Limits (AC-02, AC-03, AC-09).

Im Normalmodus wird nur verarbeitet, was ein privater Textchat des konfigurierten Betreibers ist.
Alles andere wird ohne Antwort verworfen.
"""

import collections
import datetime
from dataclasses import dataclass

try:  # Zeitzone Europe/Vienna; ohne tzdata Rückfall auf UTC
    import zoneinfo

    try:
        VIENNA = zoneinfo.ZoneInfo("Europe/Vienna")
        VIENNA_NAME = "Europe/Vienna"
    except zoneinfo.ZoneInfoNotFoundError:
        VIENNA = datetime.timezone.utc
        VIENNA_NAME = "UTC"
except ImportError:  # pragma: no cover
    VIENNA = datetime.timezone.utc
    VIENNA_NAME = "UTC"

_FORWARD_KEYS = (
    "forward_origin",
    "forward_from",
    "forward_from_chat",
    "forward_from_message_id",
    "forward_signature",
    "forward_sender_name",
    "forward_date",
)


@dataclass(frozen=True)
class Verdict:
    accept: bool
    reason: str
    chat_id: int = 0
    text: str = ""


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def classify(update, allowed_user_id):
    """Entscheidet, ob ein Update verarbeitet wird. `reason` ist eine unpersönliche Kategorie."""
    if not isinstance(update, dict):
        return Verdict(False, "malformed")
    message = update.get("message")
    if not isinstance(message, dict):
        return Verdict(False, "not_message")
    chat = message.get("chat")
    if not isinstance(chat, dict) or chat.get("type") != "private":
        return Verdict(False, "not_private")
    sender = message.get("from")
    if not isinstance(sender, dict) or sender.get("is_bot") is not False:
        return Verdict(False, "bot_or_unknown")
    sender_id = sender.get("id")
    if not _is_int(allowed_user_id) or allowed_user_id <= 0 or not _is_int(sender_id) or sender_id != allowed_user_id:
        return Verdict(False, "unauthorized")
    chat_id = chat.get("id")
    if not _is_int(chat_id) or chat_id != sender_id:
        return Verdict(False, "malformed")
    if any(key in message for key in _FORWARD_KEYS):
        return Verdict(False, "forwarded")
    if "via_bot" in message:
        return Verdict(False, "via_bot")
    text = message.get("text")
    if not isinstance(text, str) or not text.strip():
        return Verdict(False, "no_text")
    return Verdict(True, "ok", chat_id=chat_id, text=text)


class SlidingWindowLimiter:
    """Gleitendes Fenster: höchstens `limit` Ereignisse in `window_s` Sekunden."""

    def __init__(self, limit, window_s, clock):
        self._limit = limit
        self._window = window_s
        self._clock = clock
        self._events = collections.deque()

    def allow(self):
        now = self._clock()
        while self._events and now - self._events[0] >= self._window:
            self._events.popleft()
        if len(self._events) >= self._limit:
            return False
        self._events.append(now)
        return True


def day_key(epoch_seconds, tz=VIENNA):
    """Kalendertag (lokale Zeit) als String; Tageswechsel inkl. Sommerzeit korrekt."""
    return datetime.datetime.fromtimestamp(epoch_seconds, tz).strftime("%Y-%m-%d")
