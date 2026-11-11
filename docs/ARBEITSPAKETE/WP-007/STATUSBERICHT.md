# WP-007 OpenClaw – Statusbericht (Stand 2026-11-09)

**Definition of Done: NICHT erreicht.** Nichts davon ist auf dem VPS installiert; das Python-Gateway läuft unverändert.

| Punkt | Stand |
|---|---|
| Installations-/Umschalt-/Rückweg-/Verifikationsskripte | fertig, statisch getestet (26 Tests grün), `systemd-analyze security` Exposure 1.2 / 1.4 |
| OpenClaw 2026.11.2 im Wegwerf-Lauf (unprivilegiert) | startet, Konfig validiert, Audit 0 critical, Loopback-only |
| DeepSeek-Echttest, Telegram-Senden/Empfangen, fremde Nutzer gesperrt, Auto-Neustart, Stop | **nicht ausgeführt** (benötigt sudo-Installation + Freigabe) |
| Umschaltung Telegram | **nicht erfolgt** (Freigabe des Betreibers nötig) |
| Coding-Agent | **gesperrt** (Blocker siehe `infra/openclaw/README.md`) |

Fehlende Benutzeraktionen: Freigabe `install.sh`, danach `verify.sh`, danach ausdrückliche Freigabe der Umschaltung; Entscheidung zur Container-Isolation für Phase B.
