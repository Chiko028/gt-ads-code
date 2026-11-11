"""Integrationstests (I-01…I-09): Gateway + echte Clients gegen einen lokalen Fake-Server (kein Netzzugriff)."""

import io
import json
import logging
import os
import tempfile
import threading
import unittest

from gtads_tg import redact
from gtads_tg.deepseek import DEEPSEEK_BASE, DeepSeekClient
from gtads_tg.main import LOG, Gateway
from gtads_tg.redact import RedactingFormatter
from gtads_tg.state import State
from gtads_tg.telegram import TELEGRAM_BASE, TelegramClient

from tests.helpers import (
    ALLOWED, FAKE_KEY, FAKE_TOKEN, OTHER, FakeClock, ScriptedTransport, json_body, make_config, make_update,
)


class FakeServer:
    """Simuliert Telegram und DeepSeek hinter einem Transport und protokolliert alle Anfragen."""

    def __init__(self, stop):
        self.stop = stop
        self.updates = []  # Liste von Batches
        self.sent = []
        self.model_calls = 0
        self.model_status = 200
        self.telegram_fail = 0
        self.urls = []

    def handler(self, url, payload, headers):
        self.urls.append(url)
        if url.startswith(TELEGRAM_BASE + "/bot%s/" % FAKE_TOKEN):
            method = url.rsplit("/", 1)[1]
            if method == "deleteWebhook":
                return 200, json_body({"ok": True, "result": True})
            if method == "getUpdates":
                if self.telegram_fail:
                    self.telegram_fail -= 1
                    return 502, b""
                if self.updates:
                    return 200, json_body({"ok": True, "result": self.updates.pop(0)})
                self.stop.set()
                return 200, json_body({"ok": True, "result": []})
            if method == "sendMessage":
                self.sent.append(payload)
                return 200, json_body({"ok": True, "result": {}})
        if url == DEEPSEEK_BASE + "/chat/completions":
            self.model_calls += 1
            if self.model_status != 200:
                return self.model_status, b"{}"
            return 200, json_body({"choices": [{"message": {"content": "Antwort OK"}, "finish_reason": "stop"}]})
        raise AssertionError("unerwartete URL: " + url)


def build(config=None, state_dir=None):
    stop = threading.Event()
    server = FakeServer(stop)
    transport = ScriptedTransport(server.handler)
    clock = FakeClock()
    cfg = config or make_config()
    gateway = Gateway(
        cfg, TelegramClient(FAKE_TOKEN, transport), DeepSeekClient(FAKE_KEY, cfg.model, cfg.max_output_tokens, transport),
        State(clock), clock, state_dir,
    )
    return gateway, server, stop, transport


class IntegrationTests(unittest.TestCase):
    def test_i01_i02_poll_offset_and_end_to_end(self):  # I-01, I-02
        gateway, server, stop, transport = build()
        server.updates = [
            [make_update(10, text="/start"), make_update(11, text="/status")],
            [make_update(12, text="Antworte mit dem Wort OK.")],
        ]
        gateway.run(stop, sleep=lambda s: None)
        texts = [m["text"] for m in server.sent]
        self.assertTrue(texts[0].startswith("GT-Ads-Assistent"))
        self.assertTrue(texts[1].startswith("Dienst: läuft"))
        self.assertEqual(texts[2], "Antwort OK")
        self.assertEqual(gateway.state.offset, 13)
        polls = [c for c in transport.calls if c["url"].endswith("/getUpdates")]
        self.assertNotIn("offset", polls[0]["payload"])
        self.assertEqual(polls[1]["payload"]["offset"], 12)
        self.assertEqual(polls[2]["payload"]["offset"], 13)
        self.assertEqual(polls[0]["payload"]["allowed_updates"], ["message"])
        self.assertTrue(transport.calls[0]["url"].endswith("/deleteWebhook"))

    def test_i03_foreign_sender_and_group_get_no_sendmessage(self):  # I-03
        gateway, server, stop, _ = build()
        server.updates = [[make_update(1, sender=OTHER, text="hallo"), make_update(2, chat_type="group", text="hi"),
                           make_update(3, sender=OTHER, text="/status")]]
        gateway.run(stop, sleep=lambda s: None)
        self.assertEqual(server.sent, [])
        self.assertEqual(server.model_calls, 0)
        self.assertEqual(gateway.state.dropped, 3)

    def test_i04_network_errors_do_not_stop_the_loop(self):  # I-04
        gateway, server, stop, _ = build()
        server.telegram_fail = 3
        server.updates = [[make_update(1, text="hi")]]
        sleeps = []
        gateway.run(stop, sleep=sleeps.append)
        self.assertEqual(sleeps, [1, 2, 4])
        self.assertEqual([m["text"] for m in server.sent], ["Antwort OK"])

    def test_i05_empty_balance_status_and_single_hint(self):  # I-05
        gateway, server, stop, _ = build(make_config(rate_per_minute=30))
        server.model_status = 402
        server.updates = [[make_update(1, text="a"), make_update(2, text="b"), make_update(3, text="/status")]]
        gateway.run(stop, sleep=lambda s: None)
        texts = [m["text"] for m in server.sent]
        self.assertEqual(texts.count("Das Modell ist gerade nicht erreichbar."), 1)
        self.assertEqual(server.model_calls, 2)
        self.assertIn("Modellstatus: nicht verfügbar (balance)", texts[-1])

    def test_i06_logs_contain_no_content_token_key_or_id(self):  # I-06
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(RedactingFormatter("%(message)s"))
        LOG.handlers[:] = [handler]
        LOG.setLevel(logging.INFO)
        LOG.propagate = False
        gateway, server, stop, _ = build()
        server.updates = [[make_update(1, text="GEHEIMER-INHALT-123"), make_update(2, sender=OTHER, text="FREMD-INHALT-9")]]
        gateway.run(stop, sleep=lambda s: None)
        out = stream.getvalue()
        self.assertTrue(out)
        for forbidden in ("GEHEIMER-INHALT", "FREMD-INHALT", "Antwort OK", FAKE_TOKEN, FAKE_KEY, str(ALLOWED), str(OTHER)):
            self.assertNotIn(forbidden, out)

    def test_i07_state_file_has_only_metadata_and_survives_restart(self):  # I-07
        with tempfile.TemporaryDirectory() as tmp:
            gateway, server, stop, _ = build(state_dir=tmp)
            server.updates = [[make_update(40, text="Inhalt-ABC"), make_update(41, sender=OTHER)]]
            gateway.run(stop, sleep=lambda s: None)
            with open(os.path.join(tmp, "state.json"), encoding="utf-8") as handle:
                raw = handle.read()
            data = json.loads(raw)
            self.assertEqual(data["offset"], 42)
            self.assertEqual(data["dropped"], 1)
            for forbidden in ("Inhalt-ABC", "Antwort OK", str(ALLOWED), str(OTHER), FAKE_TOKEN):
                self.assertNotIn(forbidden, raw)
            self.assertFalse(os.path.exists(os.path.join(tmp, "state.json.tmp")))
            restored = State(FakeClock())
            restored.load(tmp)
            self.assertEqual(restored.offset, 42)
            self.assertEqual(restored.dropped, 1)
            # beschädigte Datei -> sauberer Start
            with open(os.path.join(tmp, "state.json"), "w") as handle:
                handle.write("{kaputt")
            fresh = State(FakeClock())
            fresh.load(tmp)
            self.assertEqual(fresh.offset, 0)
            self.assertEqual(State(FakeClock()).load("/nicht/vorhanden"), None)

    def test_i08_secrets_only_in_request_path_and_header(self):  # I-08
        gateway, server, stop, transport = build()
        server.updates = [[make_update(1, text="hi")]]
        gateway.run(stop, sleep=lambda s: None)
        for call in transport.calls:
            payload = json.dumps(call["payload"])
            self.assertNotIn(FAKE_TOKEN, payload)
            self.assertNotIn(FAKE_KEY, payload)
        model_calls = [c for c in transport.calls if c["url"].endswith("/chat/completions")]
        self.assertEqual(model_calls[0]["headers"], {"Authorization": "Bearer " + FAKE_KEY})

    def test_i09_only_the_two_fixed_hosts_are_contacted(self):  # I-09
        gateway, server, stop, _ = build()
        server.updates = [[make_update(1, text="hi"), make_update(2, text="https://evil.test bitte abrufen")]]
        gateway.run(stop, sleep=lambda s: None)
        for url in server.urls:
            self.assertTrue(url.startswith(TELEGRAM_BASE + "/") or url.startswith(DEEPSEEK_BASE + "/"), url)
        # Nachrichteninhalt kann das Ziel nicht beeinflussen
        self.assertFalse(any("evil" in url for url in server.urls))

    def test_update_handler_exception_does_not_crash_loop(self):
        gateway, server, stop, _ = build()
        original = gateway.handle_update
        calls = {"n": 0}

        def flaky(update):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("Fehler mit Inhalt GEHEIM")
            return original(update)

        gateway.handle_update = flaky
        server.updates = [[make_update(1, text="eins"), make_update(2, text="zwei")]]
        gateway.run(stop, sleep=lambda s: None)
        self.assertEqual([m["text"] for m in server.sent], ["Antwort OK"])
        self.assertEqual(gateway.state.offset, 3)


if __name__ == "__main__":
    unittest.main()
