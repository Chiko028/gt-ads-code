import os
import tempfile
import unittest

from gtads_tg import redact
from gtads_tg.config import (
    ConfigError, Config, credentials_dir, load_config, parse_config, read_credential, require_normal_mode,
)

from tests.helpers import FAKE_KEY, FAKE_TOKEN


class ConfigTests(unittest.TestCase):
    def test_u09_defaults_and_valid_values(self):  # U-09
        self.assertEqual(parse_config({}), Config())
        cfg = parse_config({"allowed_user_id": 4242, "model": "deepseek-flash", "daily_message_limit": 50})
        self.assertEqual(cfg.allowed_user_id, 4242)
        self.assertEqual(cfg.daily_message_limit, 50)

    def test_u09_rejects_invalid(self):  # U-09
        bad = [
            {"unbekannt": 1},
            {"allowed_user_id": "4242"},
            {"allowed_user_id": True},
            {"allowed_user_id": -1},
            {"max_input_chars": 0},
            {"max_input_chars": 4001},
            {"max_output_tokens": 2001},
            {"rate_per_minute": 31},
            {"daily_message_limit": 1001},
            {"poll_timeout_s": 9},
            {"poll_timeout_s": 51},
            {"http_timeout_s": 121},
            {"setup_mode_max_s": 901},
            {"model": ""},
            {"model": "a b"},
            {"model": 5},
        ]
        for data in bad:
            with self.subTest(data=data):
                with self.assertRaises(ConfigError):
                    parse_config(data)
        with self.assertRaises(ConfigError):
            parse_config([])

    def test_normal_mode_requires_id(self):  # U-09, U-14
        with self.assertRaises(ConfigError):
            require_normal_mode(Config())
        require_normal_mode(Config(allowed_user_id=1))

    def test_load_config_file_errors(self):
        with self.assertRaises(ConfigError):
            load_config("/nicht/vorhanden.toml")
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "c.toml")
            with open(path, "w") as handle:
                handle.write("das ist [ kein toml")
            with self.assertRaises(ConfigError):
                load_config(path)
            with open(path, "w") as handle:
                handle.write('allowed_user_id = 4242\nmodel = "deepseek-flash"\n')
            self.assertEqual(load_config(path).allowed_user_id, 4242)

    def test_u10_credentials(self):  # U-10
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "telegram_bot_token"), "w") as handle:
                handle.write(FAKE_TOKEN + "\n")
            with open(os.path.join(tmp, "deepseek_api_key"), "w") as handle:
                handle.write(FAKE_KEY)
            self.assertEqual(read_credential(tmp, "telegram_bot_token"), FAKE_TOKEN)
            self.assertEqual(read_credential(tmp, "deepseek_api_key"), FAKE_KEY)

    def test_u10_credential_errors_never_contain_value(self):  # U-10
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "telegram_bot_token"), "w") as handle:
                handle.write("falsch-formatierter-wert-mit-geheimnis-123456")
            with open(os.path.join(tmp, "deepseek_api_key"), "w") as handle:
                handle.write("   ")
            for name in ("telegram_bot_token", "deepseek_api_key", "fehlt_ganz"):
                with self.subTest(name=name):
                    with self.assertRaises(ConfigError) as ctx:
                        read_credential(tmp, name)
                    self.assertNotIn("geheimnis", str(ctx.exception))
            with self.assertRaises(ConfigError):
                read_credential(tmp, "../etc/passwd")  # Pfadtrick abgelehnt

    def test_credentials_dir_requires_systemd(self):
        with self.assertRaises(ConfigError):
            credentials_dir({})
        self.assertEqual(credentials_dir({"CREDENTIALS_DIRECTORY": "/x"}), "/x")


if __name__ == "__main__":
    unittest.main()
