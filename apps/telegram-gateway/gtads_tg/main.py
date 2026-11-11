"""Hauptschleife, Setup-Modus und Einstiegspunkt (AC-01, AC-10, AC-12, AC-13).

Nur ausgehende Verbindungen (Long Polling). Kein Listener, kein Webhook.
"""

import argparse
import logging
import signal
import sys
import threading
import time

from . import __version__
from . import commands
from .config import ConfigError, credentials_dir, load_config, read_credential, require_normal_mode
from .deepseek import DeepSeekClient, ModelError
from .policy import SlidingWindowLimiter, classify, day_key
from .redact import RedactingFormatter, log_event, register_secret
from .state import State
from .telegram import TelegramClient, TelegramError, TransportError, UrllibTransport

DEFAULT_STATE_DIR = "/srv/taxiagents/telegram/state"
LOG = logging.getLogger("gtads_tg")


class Gateway:
    """Verarbeitet Updates nach Policy. Alle Abhängigkeiten sind injizierbar (Tests)."""

    def __init__(self, config, telegram, model, state, clock=time.time, state_dir=None):
        self.config = config
        self.telegram = telegram
        self.model = model
        self.state = state
        self.clock = clock
        self.state_dir = state_dir
        self.rate = SlidingWindowLimiter(config.rate_per_minute, 60, lambda: self.clock())

    # --- Senden ---------------------------------------------------------------
    def _send(self, chat_id, text):
        try:
            self.telegram.send_message(chat_id, text, self.config.http_timeout_s)
            log_event(LOG, "send", "ok", len=len(text))
        except (TelegramError, TransportError) as error:
            log_event(LOG, "send", "error", status=getattr(error, "status", 0))

    # --- Update-Verarbeitung -------------------------------------------------
    def handle_update(self, update):
        verdict = classify(update, self.config.allowed_user_id)
        if not verdict.accept:
            self.state.record_dropped()
            log_event(LOG, "update_dropped", "dropped", reason=verdict.reason)
            return
        self.state.record_processed()
        chat_id, text = verdict.chat_id, verdict.text
        if not self.rate.allow():
            self.state.record_rate_limited()
            log_event(LOG, "limit", "rate")
            self._send(chat_id, commands.RATE_TEXT)
            return
        command = commands.parse_command(text)
        if command == "/start":
            log_event(LOG, "command", "start")
            self._send(chat_id, commands.START_TEXT)
        elif command == "/status":
            log_event(LOG, "command", "status")
            self._send(chat_id, commands.render_status(self.state, self.config, self.clock()))
        elif command is not None:
            log_event(LOG, "command", "unknown")
            self._send(chat_id, commands.UNKNOWN_TEXT)
        else:
            self._handle_text(chat_id, text)

    def _handle_text(self, chat_id, text):
        if len(text) > self.config.max_input_chars:
            log_event(LOG, "limit", "too_long", len=len(text))
            self._send(chat_id, commands.TOO_LONG_TEXT % self.config.max_input_chars)
            return
        today = day_key(self.clock())
        if self.state.daily_used(today) >= self.config.daily_message_limit:
            log_event(LOG, "limit", "daily")
            self._send(chat_id, commands.DAILY_TEXT)
            return
        self.state.count_daily(today)
        try:
            answer = self.model.chat(text, self.config.http_timeout_s)
        except ModelError as error:
            self.state.record_model_error(error.kind)
            log_event(LOG, "model_call", "error", **{"class": error.kind})
            if not self.state.outage_notified:
                self.state.outage_notified = True
                self._send(chat_id, commands.MODEL_DOWN_TEXT)
            return
        self.state.record_model_ok()
        log_event(LOG, "model_call", "ok", len=len(answer))
        self._send(chat_id, answer)

    # --- Schleife ----------------------------------------------------------------
    def _persist(self):
        if self.state_dir:
            try:
                self.state.save(self.state_dir)
            except OSError:
                log_event(LOG, "state", "save_error")

    def run(self, stop, sleep=None):
        """Long-Polling-Schleife bis `stop` gesetzt ist. Fehler führen zu Backoff, nie zum Abbruch."""
        wait = sleep or stop.wait
        try:
            self.telegram.delete_webhook()
        except (TelegramError, TransportError):
            log_event(LOG, "startup", "webhook_delete_failed")
        backoff = 1
        while not stop.is_set():
            try:
                updates = self.telegram.get_updates(
                    self.state.offset, self.config.poll_timeout_s, self.config.poll_timeout_s + 10
                )
            except (TelegramError, TransportError) as error:
                log_event(LOG, "poll", "error", status=getattr(error, "status", 0))
                delay = max(backoff, getattr(error, "retry_after", 0))
                backoff = min(backoff * 2, 60)
                wait(delay)
                continue
            backoff = 1
            self.state.record_poll_ok()
            for update in updates:
                update_id = update.get("update_id") if isinstance(update, dict) else None
                try:
                    self.handle_update(update)
                except Exception as error:  # nie wegen eines Updates abstürzen, nie Inhalte loggen
                    log_event(LOG, "update", "error", **{"class": type(error).__name__})
                if isinstance(update_id, int) and not isinstance(update_id, bool):
                    self.state.offset = max(self.state.offset, update_id + 1)
            if updates:
                self._persist()
        self._persist()


def run_setup(telegram, max_seconds, clock, stop, poll_timeout=30, http_timeout=40):
    """Setup-Modus (E68): protokolliert nur numerische Absender-IDs privater Nachrichten, antwortet nie."""
    end = clock() + max_seconds
    offset = 0
    while not stop.is_set() and clock() < end:
        remaining = int(end - clock())
        if remaining <= 0:
            break
        try:
            updates = telegram.get_updates(offset, max(1, min(poll_timeout, remaining)), http_timeout)
        except (TelegramError, TransportError):
            log_event(LOG, "poll", "error")
            stop.wait(2)
            continue
        for update in updates:
            if not isinstance(update, dict):
                continue
            update_id = update.get("update_id")
            if isinstance(update_id, int) and not isinstance(update_id, bool):
                offset = max(offset, update_id + 1)
            message = update.get("message")
            if not isinstance(message, dict):
                continue
            chat, sender = message.get("chat"), message.get("from")
            if isinstance(chat, dict) and chat.get("type") == "private" and isinstance(sender, dict):
                sender_id = sender.get("id")
                if isinstance(sender_id, int) and not isinstance(sender_id, bool):
                    log_event(LOG, "setup_id", "seen", id=sender_id)
    log_event(LOG, "shutdown", "setup_done")


def _setup_logging():
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(RedactingFormatter("%(asctime)s %(message)s"))
    LOG.handlers[:] = [handler]
    LOG.setLevel(logging.INFO)
    LOG.propagate = False


def build_parser():
    parser = argparse.ArgumentParser(prog="gtads_tg", description="GT-Ads Telegram-Gateway (Phase 1, schreibgeschützt)")
    parser.add_argument("--config", default="/etc/gt-ads/telegram-gateway.toml")
    parser.add_argument("--state-dir", default=DEFAULT_STATE_DIR)
    parser.add_argument("--setup", action="store_true", help="Setup-Modus: nur numerische Absender-ID protokollieren")
    parser.add_argument("--check-config", action="store_true", help="Konfiguration prüfen und beenden")
    parser.add_argument("--version", action="store_true")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.version:
        print(__version__)
        return 0
    _setup_logging()
    try:
        config = load_config(args.config)
        if not args.setup:
            require_normal_mode(config)
        if args.check_config:
            print("Konfiguration ok")
            return 0
        directory = credentials_dir()
        token = read_credential(directory, "telegram_bot_token")
        register_secret(token)
        api_key = None
        if not args.setup:
            api_key = read_credential(directory, "deepseek_api_key")
            register_secret(api_key)
    except ConfigError as error:
        print("Startfehler: %s" % error, file=sys.stderr)
        return 2

    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    transport = UrllibTransport()
    telegram = TelegramClient(token, transport)
    log_event(LOG, "startup", "setup" if args.setup else "normal", version=__version__)
    if args.setup:
        run_setup(telegram, config.setup_mode_max_s, time.time, stop)
        return 0
    state = State(time.time)
    state.load(args.state_dir)
    model = DeepSeekClient(api_key, config.model, config.max_output_tokens, transport)
    gateway = Gateway(config, telegram, model, state, time.time, args.state_dir)
    gateway.run(stop)
    log_event(LOG, "shutdown", "normal")
    return 0


if __name__ == "__main__":
    sys.exit(main())
