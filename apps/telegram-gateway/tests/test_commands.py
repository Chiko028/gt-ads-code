import re
import unittest

from gtads_tg import commands

from tests.helpers import ALLOWED, FakeClock, make_config, make_state

REQUIRED_FIELDS = [
    "Dienst:", "Version:", "Laufzeit:", "Modus:", "Modell:", "Letzter Telegram-Poll:",
    "Letzter Modellaufruf OK:", "Modellstatus:", "Nachrichten heute:", "Verworfen (gesamt):",
    "Modellfehler (gesamt):", "Ratenlimit-Treffer (gesamt):",
]


class CommandTests(unittest.TestCase):
    def test_u07_start_and_unknown_texts(self):  # U-07
        self.assertIn("nur Chat, schreibgeschützt", commands.START_TEXT.replace("Nur Chat", "nur Chat"))
        self.assertIn("keine Shell", commands.START_TEXT)
        self.assertEqual(commands.UNKNOWN_TEXT, "Unbekannter Befehl. Verfügbar: /start, /status.")

    def test_parse_command(self):
        self.assertEqual(commands.parse_command("/start"), "/start")
        self.assertEqual(commands.parse_command("/STATUS extra"), "/status")
        self.assertEqual(commands.parse_command("/start@Dipshit28_bot"), "/start")
        self.assertIsNone(commands.parse_command("hallo /start"))
        self.assertIsNone(commands.parse_command(""))

    def test_u07_status_fields_and_no_secrets(self):  # U-07
        clock = FakeClock()
        state = make_state(clock)
        clock.advance(3 * 3600 + 5 * 60)
        state.record_poll_ok()
        state.record_model_ok()
        state.record_dropped()
        state.count_daily("2026-01-01")
        config = make_config(daily_message_limit=100)
        text = commands.render_status(state, config, clock())
        lines = text.split("\n")
        for field in REQUIRED_FIELDS:
            self.assertTrue(any(line.startswith(field) for line in lines), field)
        self.assertIn("Laufzeit: 0d 3h 5m", text)
        self.assertIn("Modus: nur lesen (Phase 1)", text)
        self.assertIn("Modell: deepseek-flash", text)
        # keine IDs, Pfade, Hosts, Schlüssel
        self.assertNotIn(str(ALLOWED), text)
        for forbidden in ("/srv", "/etc", "/opt", "http", "api.", "sk-", "token", "Token"):
            self.assertNotIn(forbidden, text)
        self.assertIsNone(re.search(r"\d{5,}", text.replace("2026", "")))

    def test_status_shows_model_unavailable_class(self):
        clock = FakeClock()
        state = make_state(clock)
        state.record_model_error("balance")
        text = commands.render_status(state, make_config(), clock())
        self.assertIn("Modellstatus: nicht verfügbar (balance)", text)
        self.assertIn("Modellfehler (gesamt): 1", text)


if __name__ == "__main__":
    unittest.main()
