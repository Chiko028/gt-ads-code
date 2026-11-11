#!/usr/bin/env bash
# ChatGPT/Codex-Anmeldung per Device-Code fuer den Reviewer-Agenten (interaktiv, Benutzer occoder). KEIN API-Key.
#   sudo bash codex-login.sh            (Reviewer, Benutzer occoder)
#   sudo bash codex-login.sh --planner  (Codex-Planer, Benutzer ocplan)
# Voraussetzung: In den ChatGPT-Sicherheitseinstellungen ist "Device-Code-Anmeldung" aktiviert (OpenAI-Doku: noetig fuer Headless-Login).
# Du oeffnest den angezeigten Link in irgendeinem Browser, meldest dich an und gibst den Code ein. Token werden nie angezeigt.
set -Eeuo pipefail
cd /
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren." >&2; exit 1; }
if [ "${1:-}" = "--planner" ]; then  # eigene Anmeldung fuer den Codex-Planer (Benutzer ocplan, eigener Zustand im Planungsbereich)
  exec runuser -u ocplan -- env HOME=/var/lib/gt-ads-plan OPENCLAW_STATE_DIR=/var/lib/gt-ads-plan/.openclaw \
    OPENCLAW_CONFIG_PATH=/var/lib/gt-ads-plan/.openclaw/openclaw.json OPENCLAW_DISABLE_BONJOUR=1 \
    HTTPS_PROXY=http://127.0.0.1:3128 HTTP_PROXY=http://127.0.0.1:3128 NODE_USE_ENV_PROXY=1 NO_PROXY=127.0.0.1,localhost,::1 \
    PATH=/opt/openclaw/node/bin:/usr/bin:/bin \
    /opt/openclaw/node/bin/node /opt/openclaw/app/node_modules/openclaw/openclaw.mjs models auth login --provider openai --device-code --agent planner
fi
CUID="$(id -u occoder)"
exec runuser -u occoder -- env HOME=/var/lib/occoder XDG_RUNTIME_DIR="/run/user/$CUID" OPENCLAW_STATE_DIR=/var/lib/occoder/.openclaw \
  OPENCLAW_CONFIG_PATH=/var/lib/occoder/.openclaw/openclaw.json OPENCLAW_DISABLE_BONJOUR=1 \
  HTTPS_PROXY=http://127.0.0.1:3128 HTTP_PROXY=http://127.0.0.1:3128 NODE_USE_ENV_PROXY=1 NO_PROXY=127.0.0.1,localhost,::1 \
  PATH=/opt/openclaw/node/bin:/usr/bin:/bin \
  /opt/openclaw/node/bin/node /opt/openclaw/app/node_modules/openclaw/openclaw.mjs models auth login --provider openai --device-code --agent reviewer
