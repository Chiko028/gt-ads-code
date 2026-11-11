"""Limits und Fehlerverhalten des Gateways (U-04, U-06, U-11, U-12, U-13, U-14)."""

import threading
import unittest

from gtads_tg import commands
from gtads_tg.main import Gateway, run_setup
from gtads_tg.telegram import TelegramClient, TelegramError, TransportError

from tests.helpers import (
    ALLOWED, OTHER, FakeClock, FakeModel, FakeTelegram, ScriptedTransport, json_body, make_config, make_state,
    make_update,
)


def make_gateway(model=None, clock=None, **config):
    clock = clock or FakeClock()
    telegram = FakeTelegram()
    model = model or FakeModel()
    gateway = Gateway(make_config(**config), telegram, model, make_state(clock), clock)
    return gateway, telegram, model, clock


class LimitTests(unittest.TestCase):
    def test_u04_too_long_message_does_not_call_model(self):  # U-04
        gateway, telegram, model, _ = make_gateway(max_input_chars=10)
        gateway.handle_update(make_update(text="x" * 11))
        self.assertEqual(model.calls, [])
        self.assertEqual(telegram.sent, [(ALLOWED, commands.TOO_LONG_TEXT % 10)])
        gateway.handle_update(make_update(update_id=2, text="x" * 10))
        self.assertEqual(len(model.calls), 1)

    def test_rate_limit_answers_once_per_excess_and_skips_model(self):  # U-05/AC-09
        gateway, telegram, model, clock = make_gateway(rate_per_minute=2)
        for i in range(3):
            gateway.handle_update(make_update(update_id=i + 1, text="hi"))
        self.assertEqual(len(model.calls), 2)
        self.assertEqual(telegram.sent[-1], (ALLOWED, commands.RATE_TEXT))
        self.assertEqual(gateway.state.rate_limited, 1)
        clock.advance(61)
        gateway.handle_update(make_update(update_id=9, text="hi"))
        self.assertEqual(len(model.calls), 3)

    def test_u06_daily_limit_blocks_model_and_resets_next_day(self):  # U-06
        gateway, telegram, model, clock = make_gateway(daily_message_limit=3, rate_per_minute=30)
        for i in range(5):
            gateway.handle_update(make_update(update_id=i + 1, text="hi"))
        self.assertEqual(len(model.calls), 3)
        self.assertEqual(telegram.sent[-1], (ALLOWED, commands.DAILY_TEXT))
        clock.advance(86400 * 2)
        gateway.handle_update(make_update(update_id=20, text="hi"))
        self.assertEqual(len(model.calls), 4)

    def test_commands_do_not_count_against_daily_limit(self):
        gateway, _, model, _ = make_gateway(daily_message_limit=1, rate_per_minute=30)
        for i in range(5):
            gateway.handle_update(make_update(update_id=i + 1, text="/status"))
        gateway.handle_update(make_update(update_id=9, text="hi"))
        self.assertEqual(len(model.calls), 1)

    def test_u11_model_error_sends_exactly_one_hint_per_outage(self):  # U-11
        model = FakeModel(error_kind="balance")
        gateway, telegram, _, _ = make_gateway(model=model, rate_per_minute=30)
        for i in range(3):
            gateway.handle_update(make_update(update_id=i + 1, text="hi"))
        hints = [s for s in telegram.sent if s[1] == commands.MODEL_DOWN_TEXT]
        self.assertEqual(len(hints), 1)
        self.assertEqual(gateway.state.model_errors, 3)
        self.assertFalse(gateway.state.model_available)
        self.assertEqual(gateway.state.model_error_class, "balance")
        # Erholung beendet die Störungsphase; neue Störung -> neuer Hinweis
        model.error_kind = None
        gateway.handle_update(make_update(update_id=10, text="hi"))
        self.assertTrue(gateway.state.model_available)
        self.assertFalse(gateway.state.outage_notified)
        model.error_kind = "server"
        gateway.handle_update(make_update(update_id=11, text="hi"))
        self.assertEqual(len([s for s in telegram.sent if s[1] == commands.MODEL_DOWN_TEXT]), 2)

    def test_dropped_updates_get_no_reply(self):
        gateway, telegram, model, _ = make_gateway()
        gateway.handle_update(make_update(sender=OTHER))
        gateway.handle_update(make_update(chat_type="group"))
        self.assertEqual(telegram.sent, [])
        self.assertEqual(model.calls, [])
        self.assertEqual(gateway.state.dropped, 2)

    def test_u12_long_reply_is_truncated_to_4096(self):  # U-12
        sent = []

        def handler(url, payload, headers):
            sent.append(payload["text"])
            return 200, json_body({"ok": True, "result": {}})

        client = TelegramClient("111111:" + "B" * 35, ScriptedTransport(handler))
        client.send_message(ALLOWED, "ä€😀" * 3000)
        self.assertEqual(len(sent[0]), 4096)
        self.assertTrue(sent[0].endswith("…"))

    def test_u13_backoff_grows_and_resets(self):  # U-13
        telegram = FakeTelegram()
        telegram.fail_get = [TransportError("x")] * 8
        stop = threading.Event()
        sleeps = []

        def fake_sleep(seconds):
            sleeps.append(seconds)

        # nach den Fehlern: ein erfolgreicher leerer Poll, dann Fehler (Backoff startet bei 1), dann Stopp
        telegram.on_empty = stop.set
        gateway = Gateway(make_config(), telegram, FakeModel(), make_state(FakeClock()), FakeClock())
        gateway.run(stop, sleep=fake_sleep)
        self.assertEqual(sleeps, [1, 2, 4, 8, 16, 32, 60, 60])
        # nach Erfolg zurückgesetzt
        telegram2 = FakeTelegram()
        telegram2.fail_get = [TransportError("x"), TransportError("x")]
        stop2 = threading.Event()
        sleeps2 = []
        calls = {"n": 0}

        def on_empty():
            calls["n"] += 1
            if calls["n"] == 1:
                telegram2.fail_get = [TransportError("x")]
            else:
                stop2.set()

        telegram2.on_empty = on_empty
        Gateway(make_config(), telegram2, FakeModel(), make_state(FakeClock()), FakeClock()).run(stop2, sleep=sleeps2.append)
        self.assertEqual(sleeps2, [1, 2, 1])

    def test_retry_after_is_respected(self):
        telegram = FakeTelegram()
        telegram.fail_get = [TelegramError("x", 429, 7)]
        stop = threading.Event()
        telegram.on_empty = stop.set
        sleeps = []
        Gateway(make_config(), telegram, FakeModel(), make_state(FakeClock()), FakeClock()).run(stop, sleep=sleeps.append)
        self.assertEqual(sleeps, [7])

    def test_u14_setup_mode_logs_only_id_never_replies_and_ends(self):  # U-14
        clock = FakeClock()
        telegram = FakeTelegram(batches=[[make_update(update_id=5, sender=OTHER, text="geheim"),
                                          make_update(update_id=6, sender=OTHER, chat_type="group")]])
        stop = threading.Event()

        def advance():
            clock.advance(400)

        telegram.on_empty = advance
        with self.assertLogs("gtads_tg", level="INFO") as logs:
            run_setup(telegram, 600, clock, stop)
        text = "\n".join(logs.output)
        self.assertIn("setup_id seen id=%d" % OTHER, text)
        self.assertEqual(text.count("setup_id"), 1)  # Gruppe ignoriert
        self.assertNotIn("geheim", text)
        self.assertEqual(telegram.sent, [])
        self.assertIn("setup_done", text)
        self.assertEqual(telegram.get_calls[1][0], 7)  # Offset bestätigt


if __name__ == "__main__":
    unittest.main()
