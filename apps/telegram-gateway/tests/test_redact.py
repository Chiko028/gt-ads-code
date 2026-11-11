import io
import logging
import unittest

from gtads_tg import redact

from tests.helpers import FAKE_KEY, FAKE_TOKEN


class RedactTests(unittest.TestCase):
    def setUp(self):
        redact.clear_secrets()

    def tearDown(self):
        redact.clear_secrets()

    def test_u08_patterns_are_replaced(self):  # U-08
        texts = [
            "https://api.telegram.org/bot%s/getUpdates" % FAKE_TOKEN,
            "Fehler bei %s" % FAKE_TOKEN,
            "key=%s" % FAKE_KEY,
            "Authorization: Bearer %s" % FAKE_KEY,
            "authorization=%s" % FAKE_KEY,
            "Bearer abcdefghijklmnop",
        ]
        for text in texts:
            with self.subTest(text=text[:25]):
                out = redact.redact(text)
                self.assertNotIn(FAKE_TOKEN, out)
                self.assertNotIn(FAKE_KEY, out)
                self.assertNotIn("abcdefghijklmnop", out)
                self.assertIn("REDACTED", out)

    def test_registered_secret_is_replaced_literally(self):
        redact.register_secret("meinGeheimerWert123")
        self.assertNotIn("meinGeheimerWert123", redact.redact("x meinGeheimerWert123 y"))

    def test_formatter_redacts_message_and_exception(self):
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(redact.RedactingFormatter("%(message)s"))
        logger = logging.getLogger("test_redact_logger")
        logger.handlers[:] = [handler]
        logger.setLevel(logging.INFO)
        logger.propagate = False
        try:
            raise RuntimeError("Verbindung zu https://api.telegram.org/bot%s/x" % FAKE_TOKEN)
        except RuntimeError:
            logger.exception("Fehler %s", FAKE_KEY)
        out = stream.getvalue()
        self.assertNotIn(FAKE_TOKEN, out)
        self.assertNotIn(FAKE_KEY, out)

    def test_log_event_drops_unsafe_meta(self):
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger = logging.getLogger("test_log_event")
        logger.handlers[:] = [handler]
        logger.setLevel(logging.INFO)
        logger.propagate = False
        redact.log_event(
            logger, "command", "ok", len=5, text="geheime nachricht", reason="not_private",
            **{"class": "balance", "id": 42, "x y": "q"},
        )
        redact.log_event(logger, "update", "ok", reason="enthält leerzeichen und inhalt")
        out = stream.getvalue()
        self.assertIn("command ok", out)
        self.assertIn("len=5", out)
        self.assertIn("reason=not_private", out)
        self.assertIn("class=balance", out)
        self.assertNotIn("geheime", out)
        self.assertNotIn("enthält", out)
        self.assertNotIn("x y", out)


if __name__ == "__main__":
    unittest.main()
