"""Befehle und feste Antworttexte (AC-04). Texte laut API-VERTRAG §3."""

import datetime

from . import __version__
from .policy import VIENNA, day_key

START_TEXT = (
    "GT-Ads-Assistent (Phase 1). Nur Chat, schreibgeschützt: keine Shell, keine Dateiänderungen, "
    "kein Git, kein Deployment. Befehle: /status. Freie Texte gehen an DeepSeek."
)
UNKNOWN_TEXT = "Unbekannter Befehl. Verfügbar: /start, /status."
TOO_LONG_TEXT = "Die Nachricht ist zu lang (höchstens %d Zeichen)."
RATE_TEXT = "Bitte kurz warten."
DAILY_TEXT = "Tageslimit erreicht, morgen wieder."
MODEL_DOWN_TEXT = "Das Modell ist gerade nicht erreichbar."


def parse_command(text):
    """Liefert den Befehl (`/start`, `/status`, …) oder None, wenn der Text kein Befehl ist."""
    if not text.startswith("/"):
        return None
    first = text.split(None, 1)[0]
    return first.split("@", 1)[0].lower()


def _fmt_time(epoch, tz=VIENNA):
    if epoch is None:
        return "—"
    return datetime.datetime.fromtimestamp(epoch, tz).strftime("%d.%m.%Y %H:%M:%S")


def _fmt_uptime(seconds):
    seconds = max(0, int(seconds))
    days, rest = divmod(seconds, 86400)
    hours, rest = divmod(rest, 3600)
    minutes = rest // 60
    return "%dd %dh %dm" % (days, hours, minutes)


def render_status(state, config, now):
    """Statusblock ohne Geheimnisse, IDs, Pfade oder Hostnamen (API-VERTRAG §3)."""
    if state.model_available:
        model_status = "verfügbar"
    else:
        model_status = "nicht verfügbar (%s)" % (state.model_error_class or "unbekannt")
    lines = [
        "Dienst: läuft",
        "Version: %s" % __version__,
        "Laufzeit: %s" % _fmt_uptime(now - state.started_at),
        "Modus: nur lesen (Phase 1)",
        "Modell: %s" % config.model,
        "Letzter Telegram-Poll: %s" % _fmt_time(state.last_poll_ok),
        "Letzter Modellaufruf OK: %s" % _fmt_time(state.last_model_ok),
        "Modellstatus: %s" % model_status,
        "Nachrichten heute: %d/%d" % (state.daily_used(day_key(now)), config.daily_message_limit),
        "Verworfen (gesamt): %d" % state.dropped,
        "Modellfehler (gesamt): %d" % state.model_errors,
        "Ratenlimit-Treffer (gesamt): %d" % state.rate_limited,
    ]
    return "\n".join(lines)
