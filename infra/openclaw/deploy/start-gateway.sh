#!/usr/bin/env bash
# Startet den OpenClaw-Gateway (laeuft als Benutzer openclaw, innerhalb der systemd-Sandbox).
# Geheimnisse kommen ausschliesslich aus den systemd-Credentials und werden nie ausgegeben.
set -Eeuo pipefail

CRED="${CREDENTIALS_DIRECTORY:?CREDENTIALS_DIRECTORY nicht gesetzt (Start nur ueber systemd)}"
NODE=/opt/openclaw/node/bin/node
OC=/opt/openclaw/app/node_modules/openclaw/openclaw.mjs

[ -x "$NODE" ] && [ -f "$OC" ] || { echo "OpenClaw nicht installiert" >&2; exit 1; }
for name in gateway_token deepseek_api_key telegram_bot_token; do
  [ -s "$CRED/$name" ] || { echo "Credential $name fehlt" >&2; exit 1; }
done

OPENCLAW_GATEWAY_TOKEN="$(<"$CRED/gateway_token")"
DEEPSEEK_API_KEY="$(<"$CRED/deepseek_api_key")"
export OPENCLAW_GATEWAY_TOKEN DEEPSEEK_API_KEY

exec "$NODE" "$OC" gateway run
