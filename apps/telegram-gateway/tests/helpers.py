"""Test-Hilfen: Fakes für Uhr, Transport, Telegram, Modell. Alle Werte sind synthetisch (SYN)."""

import json

from gtads_tg.config import Config
from gtads_tg.deepseek import ModelError
from gtads_tg.state import State

# Wertlose Testwerte mit realistischem *Format* (keine echten Zugangsdaten).
FAKE_TOKEN = "123456789:" + "A" * 35
FAKE_KEY = "sk-" + "x" * 30
ALLOWED = 4242  # synthetische Betreiber-ID
OTHER = 777  # synthetische fremde ID


class FakeClock:
    def __init__(self, now=1_800_000_000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def make_update(update_id=1, sender=ALLOWED, text="hallo", chat_type="private", is_bot=False, chat_id=None, **message_extra):
    message = {
        "message_id": update_id,
        "from": {"id": sender, "is_bot": is_bot, "first_name": "SYN"},
        "chat": {"id": sender if chat_id is None else chat_id, "type": chat_type},
        "date": 1_800_000_000,
    }
    if text is not None:
        message["text"] = text
    message.update(message_extra)
    return {"update_id": update_id, "message": message}


def make_config(**overrides):
    values = {"allowed_user_id": ALLOWED}
    values.update(overrides)
    return Config(**values)


class FakeTelegram:
    """Ersetzt TelegramClient: liefert vorbereitete Update-Listen und protokolliert Antworten."""

    def __init__(self, batches=None, on_empty=None):
        self.batches = list(batches or [])
        self.on_empty = on_empty
        self.sent = []
        self.get_calls = []
        self.webhook_deleted = 0
        self.fail_get = []  # Liste von Exceptions, die nacheinander ausgelöst werden

    def delete_webhook(self, http_timeout=30):
        self.webhook_deleted += 1

    def get_updates(self, offset, poll_timeout, http_timeout):
        self.get_calls.append((offset, poll_timeout, http_timeout))
        if self.fail_get:
            raise self.fail_get.pop(0)
        if self.batches:
            return self.batches.pop(0)
        if self.on_empty:
            self.on_empty()
        return []

    def send_message(self, chat_id, text, http_timeout=30):
        self.sent.append((chat_id, text))


class FakeModel:
    def __init__(self, answer="OK", error_kind=None):
        self.answer = answer
        self.error_kind = error_kind
        self.calls = []

    def chat(self, user_text, http_timeout):
        self.calls.append(user_text)
        if self.error_kind:
            raise ModelError(self.error_kind)
        return self.answer


def make_state(clock):
    return State(clock)


class ScriptedTransport:
    """Transport-Fake: `handler(url, payload, headers)` liefert (status, body_bytes) oder wirft."""

    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def post_json(self, url, payload, timeout, headers=None):
        self.calls.append({"url": url, "payload": payload, "timeout": timeout, "headers": headers or {}})
        return self.handler(url, payload, headers or {})


def json_body(obj):
    return json.dumps(obj).encode("utf-8")
