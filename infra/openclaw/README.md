# OpenClaw für GT-Ads (WP-007) – Runbook

Ziel: OpenClaw ersetzt das Python-Telegram-Gateway (WP-006). **Stand: Phase A (Chat-/Statusagent).**
Der Coding-Agent (Phase B) ist **gesperrt** – siehe „Blocker“.

## Architektur (Phase A)
- `gt-ads-openclaw.service`: Benutzer `openclaw` (nologin), Gateway nur Loopback:18789 + Token, systemd-Sandbox,
  `IPAddressDeny=any` + `IPAddressAllow=localhost`; Ausgang nur über den Egress-Proxy.
- `gt-ads-egress-proxy.service`: Benutzer `gtads-egress`, 127.0.0.1:3128, nur CONNECT :443 zu `api.telegram.org`, `api.deepseek.com`.
- Modell `deepseek/deepseek-flash`. Statusagent: `profile minimal` + `alsoAllow read, ls`, Schreib-/Shell-/Web-/Cron-/Gateway-Werkzeuge verweigert.
- Telegram: `dmPolicy allowlist` (nur Betreiber-ID), Gruppen deaktiviert. Keine neuen öffentlichen Ports.
- Secrets: `/etc/gt-ads/openclaw-credentials/` → `LoadCredential`, nie im Repo/Log.

## Ablauf (jeder privilegierte Schritt einzeln freigeben; zuerst `--dry-run` lesen)
1. `sudo bash infra/openclaw/deploy/install.sh --dry-run`, dann ohne `--dry-run` (Telegram bleibt AUS, altes Gateway läuft weiter).
2. `sudo bash infra/openclaw/deploy/sync-status-docs.sh`
3. `sudo bash infra/openclaw/deploy/verify.sh` (inkl. echtem DeepSeek-Test, Schreibtest, Netzprobe).
4. **Nur nach ausdrücklicher Freigabe:** `sudo bash infra/openclaw/deploy/switch-telegram-to-openclaw.sh` (automatischer Rückweg bei Fehler).
5. Das Python-Gateway wird **nicht** mehr verwendet (Betreiberentscheidung) und mit `remove-python-gateway.sh` entfernt. Bei einem Fehler der Umschaltung bleibt OpenClaw ohne Telegram aktiv. Rückbau von OpenClaw: `uninstall.sh`.

## Blocker / bewusst gesperrt
- **Coding-Agent**: Das Docker-Sandbox-Backend von OpenClaw benötigt den Docker-Socket (verboten); rootless Podman/Runner-Container braucht privilegierte Vorbereitung. Ohne echte Container-Isolation bleibt `exec`/Schreiben gesperrt. Eigener Linux-Benutzer allein genügt nicht.
- **PR-Erstellung** durch den Agenten: kein Minimal-GitHub-Token vorhanden → nicht aktiviert.
- **Harte Kostenlimits**: DeepSeek erzwingt keines; faktische Grenze = Prepaid-Guthaben ohne Auto-Aufladung. Aufgabenwarteschlange/Freigabebindung nicht umgesetzt.

## Annahmen / nicht verifiziert [V]
- Verhalten unter der systemd-Sandbox auf dem VPS ungetestet (Offline-Analyse/Wegwerf-Lauf nur); `MemoryDenyWriteExecute=no` wegen V8-JIT.
- Werkzeugrichtlinie des Statusagenten: HTTP-Endpunkt beweist nur Sperren, nicht `read`; maßgeblich ist der Schreibtest in `verify.sh`.
- Lizenzfeld des Plugins `@openclaw/deepseek-provider` in npm-Metadaten fehlt.

## Tests
`cd infra/openclaw && python3 -B -m unittest discover -s tests -t .`
