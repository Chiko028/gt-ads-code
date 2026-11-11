"""Telegram-Bot-API-Client (nur getUpdates, sendMessage, deleteWebhook) und HTTP-Transport.

Zielhost ist fest verdrahtet (AC-05). Das Token steht nur im URL-Pfad und wird nie geloggt.
Der Transport folgt keinen Weiterleitungen und ignoriert Proxy-Umgebungsvariablen.
"""

import json
import ssl
import urllib.error
import urllib.parse
import urllib.request

from .redact import redact

TELEGRAM_BASE = "https://api.telegram.org"
ALLOWED_HOSTS = frozenset({"api.telegram.org", "api.deepseek.com"})
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_TEXT = 4096


class TransportError(Exception):
    """Netzwerkfehler (Verbindung, Timeout, TLS). Meldung enthält keine URL."""


class TelegramError(Exception):
    def __init__(self, message, status=0, retry_after=0):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class UrllibTransport:
    """HTTPS-POST mit JSON; nur Zielhosts aus ALLOWED_HOSTS."""

    def __init__(self):
        context = ssl.create_default_context()
        self._opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), _NoRedirect, urllib.request.HTTPSHandler(context=context)
        )

    def post_json(self, url, payload, timeout, headers=None):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
            raise TransportError("Zielhost nicht erlaubt")
        request_headers = {"Content-Type": "application/json"}
        if headers:
            request_headers.update(headers)
        request = urllib.request.Request(
            url, data=json.dumps(payload).encode("utf-8"), headers=request_headers, method="POST"
        )
        try:
            with self._opener.open(request, timeout=timeout) as response:
                return response.status, response.read(MAX_RESPONSE_BYTES)
        except urllib.error.HTTPError as error:
            try:
                return error.code, error.read(MAX_RESPONSE_BYTES)
            finally:
                error.close()
        except (urllib.error.URLError, OSError, ssl.SSLError) as error:
            raise TransportError(redact(type(error).__name__))


class TelegramClient:
    def __init__(self, token, transport):
        self._token = token
        self._transport = transport

    def _call(self, method, payload, http_timeout):
        url = "%s/bot%s/%s" % (TELEGRAM_BASE, self._token, method)
        status, body = self._transport.post_json(url, payload, http_timeout, None)
        try:
            data = json.loads(body.decode("utf-8")) if body else {}
        except (ValueError, UnicodeDecodeError):
            data = {}
        if status == 200 and isinstance(data, dict) and data.get("ok") is True:
            return data.get("result")
        retry_after = 0
        if isinstance(data, dict):
            params = data.get("parameters")
            if isinstance(params, dict) and isinstance(params.get("retry_after"), int):
                retry_after = max(0, min(params["retry_after"], 300))
        raise TelegramError("Telegram %s fehlgeschlagen (HTTP %d)" % (method, status), status, retry_after)

    def delete_webhook(self, http_timeout=30):
        return self._call("deleteWebhook", {"drop_pending_updates": False}, http_timeout)

    def get_updates(self, offset, poll_timeout, http_timeout):
        payload = {"timeout": poll_timeout, "allowed_updates": ["message"], "limit": 20}
        if offset and offset > 0:
            payload["offset"] = offset
        result = self._call("getUpdates", payload, http_timeout)
        return result if isinstance(result, list) else []

    def send_message(self, chat_id, text, http_timeout=30):
        if len(text) > MAX_TEXT:
            text = text[: MAX_TEXT - 1] + "…"
        return self._call("sendMessage", {"chat_id": chat_id, "text": text}, http_timeout)
