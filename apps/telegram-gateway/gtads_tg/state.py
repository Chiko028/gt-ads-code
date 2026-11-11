"""Zustand und Zähler (nur Metadaten) mit atomarer Zustandsdatei (AC-08, AC-12).

Dies ist das **einzige** Modul, das Dateien schreibt (Test ST-03).
"""

import json
import os


class State:
    def __init__(self, clock):
        self._clock = clock
        self.started_at = clock()
        self.offset = 0
        self.processed = 0
        self.dropped = 0
        self.model_errors = 0
        self.rate_limited = 0
        self.daily_day = ""
        self.daily_count = 0
        self.last_poll_ok = None
        self.last_model_ok = None
        self.model_available = True
        self.model_error_class = ""
        self.outage_notified = False

    # --- Zähler ---------------------------------------------------------------
    def record_poll_ok(self):
        self.last_poll_ok = self._clock()

    def record_dropped(self):
        self.dropped += 1

    def record_processed(self):
        self.processed += 1

    def record_rate_limited(self):
        self.rate_limited += 1

    def count_daily(self, day):
        """Zählt einen Modellversuch für den Kalendertag `day`; liefert den neuen Stand."""
        if day != self.daily_day:
            self.daily_day = day
            self.daily_count = 0
        self.daily_count += 1
        return self.daily_count

    def daily_used(self, day):
        return self.daily_count if day == self.daily_day else 0

    def record_model_ok(self):
        self.last_model_ok = self._clock()
        self.model_available = True
        self.model_error_class = ""
        self.outage_notified = False

    def record_model_error(self, error_class):
        self.model_errors += 1
        self.model_available = False
        self.model_error_class = error_class

    # --- Persistenz -----------------------------------------------------------
    def snapshot(self):
        return {
            "offset": self.offset,
            "processed": self.processed,
            "dropped": self.dropped,
            "model_errors": self.model_errors,
            "rate_limited": self.rate_limited,
            "daily_day": self.daily_day,
            "daily_count": self.daily_count,
            "last_poll_ok": self.last_poll_ok,
            "last_model_ok": self.last_model_ok,
        }

    def restore(self, data):
        """Übernimmt gespeicherte Werte defensiv; ungültige Einträge werden ignoriert."""
        if not isinstance(data, dict):
            return

        def num(key, default):
            value = data.get(key, default)
            return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else default

        self.offset = num("offset", 0)
        self.processed = num("processed", 0)
        self.dropped = num("dropped", 0)
        self.model_errors = num("model_errors", 0)
        self.rate_limited = num("rate_limited", 0)
        self.daily_count = num("daily_count", 0)
        day = data.get("daily_day", "")
        self.daily_day = day if isinstance(day, str) and len(day) <= 10 else ""
        for key in ("last_poll_ok", "last_model_ok"):
            value = data.get(key)
            setattr(self, key, float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None)

    def save(self, state_dir):
        os.makedirs(state_dir, exist_ok=True)
        path = os.path.join(state_dir, "state.json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(self.snapshot(), handle)
        os.replace(tmp, path)

    def load(self, state_dir):
        path = os.path.join(state_dir, "state.json")
        try:
            with open(path, "r", encoding="utf-8") as handle:
                self.restore(json.load(handle))
        except (OSError, ValueError):
            return
