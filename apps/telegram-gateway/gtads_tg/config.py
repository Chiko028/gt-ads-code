"""Konfiguration und Zugangsdaten (AC-07, AC-13).

Konfigurationsdatei (TOML) enthält **keine** Geheimnisse. Bot-Token und DeepSeek-Schlüssel werden
ausschließlich aus dem systemd-Credentials-Verzeichnis (`$CREDENTIALS_DIRECTORY`) gelesen.
"""

import os
import re
import tomllib
from dataclasses import dataclass


class ConfigError(Exception):
    """Konfigurationsfehler. Die Meldung enthält nie Geheimnisse."""


@dataclass(frozen=True)
class Config:
    allowed_user_id: int = 0
    model: str = "deepseek-flash"
    max_input_chars: int = 2000
    max_output_tokens: int = 800
    rate_per_minute: int = 5
    daily_message_limit: int = 100
    poll_timeout_s: int = 50
    http_timeout_s: int = 60
    setup_mode_max_s: int = 600


# Schlüssel -> (Typ, Minimum, Maximum); Vorschlagswerte laut API-VERTRAG §5.
_INT_KEYS = {
    "allowed_user_id": (0, 2**63 - 1),
    "max_input_chars": (1, 4000),
    "max_output_tokens": (1, 2000),
    "rate_per_minute": (1, 30),
    "daily_message_limit": (1, 1000),
    "poll_timeout_s": (10, 50),
    "http_timeout_s": (10, 120),
    "setup_mode_max_s": (60, 900),
}
_MODEL_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_TOKEN_RE = re.compile(r"^\d{5,}:[A-Za-z0-9_-]{30,}$")


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def parse_config(data):
    """Validiert ein bereits geladenes Dict und liefert eine Config."""
    if not isinstance(data, dict):
        raise ConfigError("Konfiguration muss eine Tabelle sein")
    allowed = set(_INT_KEYS) | {"model"}
    unknown = sorted(set(data) - allowed)
    if unknown:
        raise ConfigError("Unbekannte Konfigurationsschlüssel: %s" % ", ".join(unknown))
    values = {}
    for key, (low, high) in _INT_KEYS.items():
        if key in data:
            value = data[key]
            if not _is_int(value):
                raise ConfigError("%s muss eine ganze Zahl sein" % key)
            if not low <= value <= high:
                raise ConfigError("%s außerhalb des zulässigen Bereichs (%d..%d)" % (key, low, high))
            values[key] = value
    if "model" in data:
        model = data["model"]
        if not isinstance(model, str) or not _MODEL_RE.match(model):
            raise ConfigError("model hat ein ungültiges Format")
        values["model"] = model
    return Config(**values)


def load_config(path):
    try:
        with open(path, "rb") as handle:
            data = tomllib.load(handle)
    except FileNotFoundError:
        raise ConfigError("Konfigurationsdatei nicht gefunden")
    except tomllib.TOMLDecodeError:
        raise ConfigError("Konfigurationsdatei ist kein gültiges TOML")
    except OSError:
        raise ConfigError("Konfigurationsdatei nicht lesbar")
    return parse_config(data)


def require_normal_mode(config):
    """Normalmodus startet nur mit eingetragener Betreiber-ID (AC-13)."""
    if config.allowed_user_id <= 0:
        raise ConfigError("allowed_user_id fehlt: Normalmodus startet nicht (Setup-Modus verwenden)")


def credentials_dir(environ=None):
    environ = os.environ if environ is None else environ
    value = environ.get("CREDENTIALS_DIRECTORY")
    if not value:
        raise ConfigError("CREDENTIALS_DIRECTORY nicht gesetzt (Start nur über systemd mit LoadCredential)")
    return value


def read_credential(directory, name):
    """Liest einen Credential-Wert. Fehlermeldungen nennen nie den Wert."""
    if not re.match(r"^[a-z_]{1,40}$", name):
        raise ConfigError("ungültiger Credential-Name")
    path = os.path.join(directory, name)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = handle.read().strip()
    except OSError:
        raise ConfigError("Credential %s fehlt oder ist nicht lesbar" % name)
    if not value:
        raise ConfigError("Credential %s ist leer" % name)
    if name == "telegram_bot_token" and not _TOKEN_RE.match(value):
        raise ConfigError("Credential telegram_bot_token hat ein ungültiges Format")
    if name == "deepseek_api_key" and len(value) < 8:
        raise ConfigError("Credential deepseek_api_key hat ein ungültiges Format")
    return value
