"""Benachrichtigung des Betreibers per Telegram (nur sendMessage, KEIN Polling -> kein Konflikt mit OpenClaw).
Verbindung nur ueber den lokalen Egress-Proxy (CONNECT), Token aus der systemd-Credential-Datei, nie geloggt."""

import http.client
import json
import os


class TelegramNotifier:
    def __init__(self, token_file, chat_id, proxy=("127.0.0.1", 3128), timeout=20):
        self.token_file, self.chat_id, self.proxy, self.timeout = token_file, int(chat_id), proxy, timeout

    def send_operator(self, text, buttons=None):
        """buttons: optionale Inline-Tastatur [[{text, callback_data}]] (nur im privaten Chat des Betreibers)."""
        with open(self.token_file, encoding="utf-8") as handle:
            token = handle.read().strip()
        conn = http.client.HTTPSConnection(self.proxy[0], self.proxy[1], timeout=self.timeout)
        conn.set_tunnel("api.telegram.org", 443)
        try:
            msg = {"chat_id": self.chat_id, "text": text[:4000], "disable_web_page_preview": True}
            if buttons:
                msg["reply_markup"] = {"inline_keyboard": buttons}
            body = json.dumps(msg)
            conn.request("POST", "/bot%s/sendMessage" % token, body=body, headers={"Content-Type": "application/json"})
            resp = conn.getresponse()
            data = resp.read(65536)
            if resp.status != 200 or not json.loads(data).get("ok"):
                raise RuntimeError("Telegram sendMessage fehlgeschlagen (HTTP %d)" % resp.status)  # kein Token/Inhalt in der Meldung
        finally:
            conn.close()
