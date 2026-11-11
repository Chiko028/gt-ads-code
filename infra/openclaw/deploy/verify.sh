#!/usr/bin/env bash
# Pruefung der OpenClaw-Installation (Phase A). NUR durch den Betreiber mit sudo; gibt nie Geheimnisse aus.
#   sudo bash verify.sh [--no-model]     # --no-model ueberspringt die beiden echten DeepSeek-Aufrufe (kosten wenige Token)
# Ausgabe: je Pruefung OK/FEHLER/INFO; Exit-Code 1 bei mindestens einem Fehler.
set -Eeuo pipefail

NO_MODEL=0
[ "${1:-}" = "--no-model" ] && NO_MODEL=1
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren." >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd / # Arbeitsverzeichnis neutral: Benutzer openclaw darf das Repo-Verzeichnis nicht lesen (EACCES)
CRED=/etc/gt-ads/openclaw-credentials
NODE=/opt/openclaw/node/bin/node
OCJS=/opt/openclaw/app/node_modules/openclaw/openclaw.mjs
FAIL=0
ok()   { printf '  OK     %s\n' "$*"; }
bad()  { printf '  FEHLER %s\n' "$*"; FAIL=1; }
info() { printf '  INFO   %s\n' "$*"; }
oc() { runuser -u openclaw -p -- env HOME=/var/lib/openclaw OPENCLAW_STATE_DIR=/var/lib/openclaw/.openclaw \
  OPENCLAW_CONFIG_PATH=/var/lib/openclaw/.openclaw/openclaw.json OPENCLAW_DISABLE_BONJOUR=1 CI=1 \
  PATH=/opt/openclaw/node/bin:/usr/bin:/bin "$NODE" "$OCJS" "$@"; }
OPENCLAW_GATEWAY_TOKEN="$(<"$CRED/gateway_token")"; export OPENCLAW_GATEWAY_TOKEN
DEEPSEEK_API_KEY="$(<"$CRED/deepseek_api_key")"

echo "[1] Dienste"
for u in gt-ads-egress-proxy gt-ads-openclaw; do
  systemctl is-active --quiet "$u" && ok "$u aktiv" || bad "$u NICHT aktiv"
  systemctl is-enabled --quiet "$u" && ok "$u Autostart aktiviert" || bad "$u Autostart NICHT aktiviert"
done
[ "$(systemctl show gt-ads-openclaw -p Restart --value)" = "on-failure" ] && ok "OpenClaw: Restart=on-failure" || bad "OpenClaw: Restart-Policy"
if [ "$(systemctl is-active gt-ads-telegram 2>/dev/null || true)" = "active" ]; then bad "Python-Gateway laeuft noch (soll entfernt sein)"; elif [ -e /opt/gt-ads/telegram-gateway ] || [ -e /etc/systemd/system/gt-ads-telegram.service ]; then bad "Reste des Python-Gateways vorhanden (Unit oder Code)"; else ok "Python-Gateway entfernt (kein Dienst, kein Code)"; fi
TG="$(oc config get channels.telegram.enabled | tr -d '[:space:]"')"
info "OpenClaw-Telegram aktiviert: $TG"
if [ "$TG" = "true" ] && systemctl is-active --quiet gt-ads-telegram; then bad "ZWEI Telegram-Poller aktiv (OpenClaw und Python)"; else ok "nie zwei Telegram-Poller gleichzeitig"; fi

echo "[2] Netzwerk"
PUB="$(ss -tlnH 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|::1)' | grep -v ':22$' || true)"
[ -z "$PUB" ] && ok "keine oeffentlichen Listener ausser SSH (22)" || bad "unerwartete Listener: $PUB"
GWL="$(ss -tlnH 2>/dev/null | awk '{print $4}' | grep ':18789$' || true)"
echo "$GWL" | grep -qvE '^(127\.0\.0\.1|\[::1\]):18789$' && bad "Gateway lauscht nicht nur auf Loopback: $GWL" || ok "Gateway nur auf Loopback ($(echo $GWL | tr '\n' ' '))"
# Proxy-Wirksamkeit: erlaubter und verbotener Host
P1="$(curl -sS -x http://127.0.0.1:3128 --max-time 20 -o /dev/null -w '%{http_code}' https://api.deepseek.com/ 2>/dev/null || true)"
[ "$P1" != "000" ] && [ -n "$P1" ] && ok "Proxy: api.deepseek.com erreichbar (HTTP $P1)" || bad "Proxy: api.deepseek.com NICHT erreichbar"
P2="$(curl -sS -x http://127.0.0.1:3128 --max-time 15 -o /dev/null -w '%{http_code}' https://example.com/ 2>/dev/null || true)"
{ [ "$P2" = "000" ] || [ -z "$P2" ]; } && ok "Proxy: example.com wird abgelehnt" || bad "Proxy: example.com NICHT abgelehnt (HTTP $P2)"
# systemd-Netzgrenze (gleiche Eigenschaften wie die Unit): direkter Internetzugriff verboten, Loopback erlaubt
if systemd-run --quiet --wait --pipe -p User=openclaw -p IPAddressDeny=any -p IPAddressAllow=localhost curl -sS --max-time 8 -o /dev/null https://example.com/ >/dev/null 2>&1; then
  bad "systemd IPAddressDeny: direkter Internetzugriff trotz Sperre moeglich"
else ok "systemd IPAddressDeny: direkter Internetzugriff blockiert"; fi
if systemd-run --quiet --wait --pipe -p User=openclaw -p IPAddressDeny=any -p IPAddressAllow=localhost curl -sS --max-time 15 -o /dev/null -x http://127.0.0.1:3128 https://api.deepseek.com/ >/dev/null 2>&1; then
  ok "Dienstidentitaet erreicht das Internet nur ueber den Loopback-Proxy"; else bad "Dienstidentitaet erreicht den Proxy nicht"; fi

echo "[3] Telegram-Richtlinie (Werte aus der Konfiguration, IDs werden nicht ausgegeben)"
[ "$(oc config get channels.telegram.dmPolicy | tr -d '[:space:]"')" = "allowlist" ] && ok "dmPolicy=allowlist" || bad "dmPolicy ist nicht allowlist"
[ "$(oc config get channels.telegram.groupPolicy | tr -d '[:space:]"')" = "disabled" ] && ok "groupPolicy=disabled (Gruppen gesperrt)" || bad "groupPolicy nicht disabled"
N="$(oc config get channels.telegram.allowFrom | tr -cd '0-9,\n' | tr ',' '\n' | grep -c . || true)"
[ "$N" = "1" ] && ok "genau 1 zugelassene Telegram-ID" || bad "zugelassene IDs: $N (erwartet 1)"

echo "[4] Werkzeug-Richtlinie des Statusagenten (tools.effective)"
if bash "$HERE/check-tools.sh" status; then ok "wirksame Werkzeugliste des Statusagenten: nur lesend"; else bad "Werkzeug-Richtlinie nicht wie erwartet"; fi

echo "[5] OpenClaw Sicherheits-Audit"
AUD="$(oc security audit 2>&1 | grep -E '^Summary:' || true)"
echo "$AUD" | grep -q '0 critical' && ok "Audit: $AUD" || bad "Audit: ${AUD:-keine Ausgabe}"

echo "[6] Dateirechte und Isolation"
[ "$(stat -c '%a %U' "$CRED")" = "700 root" ] && ok "Credentials-Verzeichnis 700 root" || bad "Credentials-Verzeichnis Rechte"
[ -z "$(find "$CRED" -type f ! -perm 600)" ] && ok "Credential-Dateien 600" || bad "Credential-Dateien nicht 600"
[ "$(stat -c '%a %U' /var/lib/openclaw)" = "700 openclaw" ] && ok "Zustand 700 openclaw" || bad "Zustand Rechte"
runuser -u openclaw -- test -w /opt/openclaw/app && bad "openclaw kann /opt/openclaw/app SCHREIBEN" || ok "Programmcode fuer openclaw schreibgeschuetzt"
for p in /etc/gt-ads/credentials /etc/gt-ads/openclaw-credentials /srv/taxiwerbung /root; do
  runuser -u openclaw -- ls "$p" >/dev/null 2>&1 && bad "openclaw kann $p lesen" || ok "openclaw kann $p nicht lesen"
done
runuser -u openclaw -- sudo -n true >/dev/null 2>&1 && bad "openclaw hat sudo" || ok "kein sudo fuer openclaw"
id -nG openclaw | tr ' ' '\n' | grep -qxE 'docker|sudo|adm|root' && bad "openclaw in privilegierter Gruppe" || ok "openclaw nur in eigener Gruppe"

echo "[7] Geheimnisse in Logs und Konfiguration"
LOG="$(journalctl -u gt-ads-openclaw -u gt-ads-egress-proxy --no-pager -n 3000 2>/dev/null || true)"
LEAK=0
for secret in "$OPENCLAW_GATEWAY_TOKEN" "$DEEPSEEK_API_KEY" "$(<"$CRED/telegram_bot_token")"; do
  if printf '%s' "$LOG" | grep -qF -- "$secret"; then LEAK=1; fi
  if grep -qF -- "$secret" /var/lib/openclaw/.openclaw/openclaw.json 2>/dev/null; then LEAK=1; fi
done
printf '%s' "$LOG" | grep -qE '[0-9]{8,10}:[A-Za-z0-9_-]{35}|sk-[A-Za-z0-9]{20,}' && LEAK=1
[ "$LEAK" -eq 0 ] && ok "keine Geheimnisse in Journal/Konfiguration gefunden" || bad "GEHEIMNIS im Journal oder in der Konfiguration gefunden"

if [ "$NO_MODEL" -eq 0 ]; then
  echo "[8] Echter DeepSeek-Test (wenige Token)"
  BODY='{"model":"deepseek-flash","messages":[{"role":"user","content":"Antworte mit dem Wort OK."}],"max_tokens":20,"stream":false,"thinking":{"type":"disabled"}}'
  RESP="$(mktemp)"
  CODE="$(printf 'header = "Authorization: Bearer %s"\n' "$DEEPSEEK_API_KEY" | curl -sS -K - --max-time 60 -o "$RESP" -w '%{http_code}' -X POST https://api.deepseek.com/chat/completions -H 'Content-Type: application/json' -d "$BODY" || echo 000)"
  python3 - "$RESP" "$CODE" <<'PY' || FAIL=1
import json,sys
code=sys.argv[2]
try: d=json.load(open(sys.argv[1]))
except Exception: d={}
ch=(d.get("choices") or [{}])[0]
print("  %-6s direkter API-Aufruf: HTTP %s, Modell laut Antwort=%s, finish=%s, Antwort=%r, Tokens=%s" % ("OK" if code=="200" and ch.get("message",{}).get("content") else "FEHLER", code, d.get("model"), ch.get("finish_reason"), (ch.get("message",{}).get("content") or "")[:40], (d.get("usage") or {}).get("total_tokens")))
sys.exit(0 if code=="200" and ch.get("message",{}).get("content") else 1)
PY
  rm -f "$RESP"
  if OUT="$(oc agent --agent status --message 'Antworte mit dem Wort OK.' --json --timeout 120 2>&1)"; then
    printf '%s' "$OUT" | grep -qi 'OK' && ok "Aufruf ueber OpenClaw (Agent status, deepseek/deepseek-flash) beantwortet" || bad "OpenClaw-Agent antwortete ohne erwarteten Inhalt"
    journalctl -u gt-ads-egress-proxy --no-pager --since "-3min" 2>/dev/null | grep -q 'allowed host=api.deepseek.com' && ok "Proxy-Log: Verbindung zu api.deepseek.com ueber den Allowlist-Proxy" || bad "Proxy-Log zeigt keine DeepSeek-Verbindung"
  else bad "OpenClaw-Agentenaufruf fehlgeschlagen"; printf '%s\n' "$OUT" | sed -E 's/[A-Za-z0-9_-]{30,}/<gekuerzt>/g' | tail -5; fi
  # Funktionaler Negativtest: Der Statusagent darf nichts schreiben (Datei darf danach nicht existieren).
  PROBE=/var/lib/openclaw/workspace-status/SCHREIBTEST.txt; rm -f "$PROBE"
  oc agent --agent status --message "Lege die Datei SCHREIBTEST.txt mit dem Inhalt x an und bestaetige." --json --timeout 120 >/dev/null 2>&1 || true
  if [ -e "$PROBE" ]; then bad "Statusagent konnte eine Datei SCHREIBEN (Richtlinie unwirksam)"; rm -f "$PROBE"; else ok "Schreibversuch des Statusagenten blieb ohne Datei (Schreibrechte gesperrt)"; fi
fi
unset DEEPSEEK_API_KEY OPENCLAW_GATEWAY_TOKEN
journalctl -u gt-ads-egress-proxy --no-pager --since "-1h" 2>/dev/null | grep -o 'denied reason=[a-z_]* host=[a-z0-9.?-]*' | sort | uniq -c | head -8 | sed 's/^/  INFO   Proxy abgelehnt (letzte Stunde): /' || true
echo
if [ "$FAIL" -eq 0 ]; then echo "ERGEBNIS: alle Pruefungen bestanden"; else echo "ERGEBNIS: mindestens eine Pruefung FEHLGESCHLAGEN"; fi
exit "$FAIL"
