import unittest

from gtads_tg.deepseek import DEEPSEEK_BASE, SYSTEM_PROMPT, DeepSeekClient, ModelError
from gtads_tg.telegram import TELEGRAM_BASE, TelegramClient, TelegramError, TransportError, UrllibTransport

from tests.helpers import FAKE_KEY, FAKE_TOKEN, ScriptedTransport, json_body


class TelegramClientTests(unittest.TestCase):
    def test_get_updates_request_shape(self):
        transport = ScriptedTransport(lambda u, p, h: (200, json_body({"ok": True, "result": [{"update_id": 1}]})))
        client = TelegramClient(FAKE_TOKEN, transport)
        self.assertEqual(client.get_updates(0, 50, 60), [{"update_id": 1}])
        call = transport.calls[0]
        self.assertEqual(call["url"], "%s/bot%s/getUpdates" % (TELEGRAM_BASE, FAKE_TOKEN))
        self.assertEqual(call["payload"]["allowed_updates"], ["message"])
        self.assertEqual(call["payload"]["timeout"], 50)
        self.assertNotIn("offset", call["payload"])  # Offset 0 wird nicht gesendet
        self.assertEqual(call["timeout"], 60)
        client.get_updates(17, 50, 60)
        self.assertEqual(transport.calls[1]["payload"]["offset"], 17)

    def test_send_message_has_no_parse_mode(self):
        transport = ScriptedTransport(lambda u, p, h: (200, json_body({"ok": True, "result": {}})))
        TelegramClient(FAKE_TOKEN, transport).send_message(5, "hallo")
        payload = transport.calls[0]["payload"]
        self.assertEqual(payload, {"chat_id": 5, "text": "hallo"})

    def test_delete_webhook_keeps_pending_updates(self):
        transport = ScriptedTransport(lambda u, p, h: (200, json_body({"ok": True, "result": True})))
        TelegramClient(FAKE_TOKEN, transport).delete_webhook()
        self.assertEqual(transport.calls[0]["payload"], {"drop_pending_updates": False})
        self.assertTrue(transport.calls[0]["url"].endswith("/deleteWebhook"))

    def test_errors_do_not_contain_token_and_carry_retry_after(self):
        body = json_body({"ok": False, "description": "Too Many Requests", "parameters": {"retry_after": 9}})
        client = TelegramClient(FAKE_TOKEN, ScriptedTransport(lambda u, p, h: (429, body)))
        with self.assertRaises(TelegramError) as ctx:
            client.get_updates(0, 50, 60)
        self.assertEqual(ctx.exception.status, 429)
        self.assertEqual(ctx.exception.retry_after, 9)
        self.assertNotIn(FAKE_TOKEN, str(ctx.exception))
        client2 = TelegramClient(FAKE_TOKEN, ScriptedTransport(lambda u, p, h: (502, b"<html>")))
        with self.assertRaises(TelegramError):
            client2.get_updates(0, 50, 60)
        client3 = TelegramClient(FAKE_TOKEN, ScriptedTransport(lambda u, p, h: (200, b"kein json")))
        with self.assertRaises(TelegramError):
            client3.send_message(1, "x")

    def test_transport_rejects_foreign_hosts_and_http(self):
        transport = UrllibTransport()
        for url in ("https://example.com/x", "http://api.telegram.org/x", "https://api.telegram.org.evil.test/x",
                    "https://evil.test/https://api.telegram.org/"):
            with self.subTest(url=url):
                with self.assertRaises(TransportError):
                    transport.post_json(url, {}, 5)


class DeepSeekClientTests(unittest.TestCase):
    def _client(self, handler, **kw):
        transport = ScriptedTransport(handler)
        return DeepSeekClient(FAKE_KEY, kw.get("model", "deepseek-flash"), kw.get("max_tokens", 800), transport), transport

    @staticmethod
    def _ok(content="OK", finish="stop"):
        return 200, json_body({"choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": finish}]})

    def test_request_shape_has_no_tools_no_history_and_thinking_disabled(self):
        client, transport = self._client(lambda u, p, h: self._ok(" Antwort \n"))
        self.assertEqual(client.chat("Hallo", 60), "Antwort")
        call = transport.calls[0]
        self.assertEqual(call["url"], DEEPSEEK_BASE + "/chat/completions")
        self.assertEqual(call["headers"], {"Authorization": "Bearer " + FAKE_KEY})
        payload = call["payload"]
        self.assertEqual(payload["model"], "deepseek-flash")
        self.assertEqual(payload["max_tokens"], 800)
        self.assertIs(payload["stream"], False)
        self.assertEqual(payload["thinking"], {"type": "disabled"})
        self.assertEqual([m["role"] for m in payload["messages"]], ["system", "user"])
        self.assertEqual(payload["messages"][0]["content"], SYSTEM_PROMPT)
        self.assertEqual(payload["messages"][1]["content"], "Hallo")
        for forbidden in ("tools", "functions", "tool_choice", "response_format"):
            self.assertNotIn(forbidden, payload)

    def test_system_prompt_states_limits(self):
        for phrase in ("keine Werkzeuge", "keine Freigaben", "Geheimnisse"):
            self.assertIn(phrase, SYSTEM_PROMPT)

    def test_error_classes(self):
        cases = {401: "auth", 402: "balance", 429: "rate", 500: "server", 503: "server", 504: "server",
                 400: "other", 422: "other", 404: "other", 302: "other"}
        for status, kind in cases.items():
            with self.subTest(status=status):
                client, _ = self._client(lambda u, p, h, s=status: (s, b"{}"))
                with self.assertRaises(ModelError) as ctx:
                    client.chat("x", 5)
                self.assertEqual(ctx.exception.kind, kind)

    def test_network_error_and_malformed_bodies(self):
        def boom(u, p, h):
            raise TransportError("Timeout")

        client, _ = self._client(boom)
        with self.assertRaises(ModelError) as ctx:
            client.chat("x", 5)
        self.assertEqual(ctx.exception.kind, "network")
        for body in (b"kein json", json_body({}), json_body({"choices": []}), json_body({"choices": [{"message": {}}]}),
                     json_body({"choices": [{"message": {"content": "   "}}]})):
            with self.subTest(body=body[:20]):
                client, _ = self._client(lambda u, p, h, b=body: (200, b))
                with self.assertRaises(ModelError) as ctx:
                    client.chat("x", 5)
                self.assertEqual(ctx.exception.kind, "other")

    def test_insufficient_system_resource_is_server_error(self):
        client, _ = self._client(lambda u, p, h: self._ok("teilweise", "insufficient_system_resource"))
        with self.assertRaises(ModelError) as ctx:
            client.chat("x", 5)
        self.assertEqual(ctx.exception.kind, "server")

    def test_model_name_is_configurable(self):
        client, transport = self._client(lambda u, p, h: self._ok(), model="deepseek-v4-pro")
        client.chat("x", 5)
        self.assertEqual(transport.calls[0]["payload"]["model"], "deepseek-v4-pro")


if __name__ == "__main__":
    unittest.main()
