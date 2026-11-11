#!/usr/bin/env bash
# Prueft die WIRKSAME Werkzeugliste des Statusagenten (OpenClaw-Methode tools.effective) gegen eine Positivliste.
#   sudo bash check-tools.sh [AGENT_ID]      (laeuft gegen den lokalen Gateway; Token wird nie ausgegeben)
# Erlaubt sind ausschliesslich lesende Werkzeuge. Jedes andere Werkzeug (exec, write, edit, process, web_*, cron, gateway ...) -> Fehler.
set -Eeuo pipefail
cd /
AGENT="${1:-status}"
ALLOWED='["ls","read","presence","session_status"]'
CRED=/etc/gt-ads/openclaw-credentials
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren." >&2; exit 1; }
OPENCLAW_GATEWAY_TOKEN="$(<"$CRED/gateway_token")"; export OPENCLAW_GATEWAY_TOKEN
oc() { runuser -u openclaw -p -- env HOME=/var/lib/openclaw OPENCLAW_STATE_DIR=/var/lib/openclaw/.openclaw \
  OPENCLAW_CONFIG_PATH=/var/lib/openclaw/.openclaw/openclaw.json OPENCLAW_DISABLE_BONJOUR=1 CI=1 \
  PATH=/opt/openclaw/node/bin:/usr/bin:/bin /opt/openclaw/node/bin/node /opt/openclaw/app/node_modules/openclaw/openclaw.mjs "$@"; }

# --- Bereitschaft abwarten (begrenztes Fenster), erst DANN Sitzung anlegen -------------------------------
WAIT_S="${CHECK_WAIT_SECONDS:-420}"
base=http://127.0.0.1:18789
code() { curl -s -m 10 -o /dev/null -w '%{http_code}' "$base/$1" || echo 000; }
deadline=$(( $(date +%s) + WAIT_S )); key=""; state="unbekannt"
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ "$(code startupz)" != "200" ] || [ "$(code readyz)" != "200" ]; then state="Start laeuft noch (startupz/readyz nicht 200)"; sleep 10; continue; fi
  created="$(oc gateway call sessions.create --timeout 60000 --json --params "{\"agentId\":\"$AGENT\"}" 2>&1)" || true
  key="$(printf '%s' "$created" | python3 -I -c 'import sys,json;t=sys.stdin.read();print(json.loads(t[t.find("{"):]).get("key",""))' 2>/dev/null || true)"
  [ -n "$key" ] && break
  if printf '%s' "$created" | grep -q -i -E 'UNAVAILABLE|startup inspection|preparation'; then
    state="Agent-Vorbereitung laeuft noch (UNAVAILABLE)"; sleep 15; continue
  fi
  echo "  FEHLER Sitzung nicht angelegt (endgueltig, kein Warten sinnvoll):" >&2
  printf '%s\n' "$created" | sed -E 's/[A-Za-z0-9_-]{32,}/<x>/g' | head -12 | sed 's/^/    /' >&2
  exit 1
done
[ -n "$key" ] || { echo "  FEHLER Zeitueberschreitung nach ${WAIT_S}s: $state. Dienst NICHT bereit; keine Werkzeugpruefung moeglich." >&2; exit 2; }
eff="$(oc gateway call tools.effective --timeout 90000 --json --params "{\"agentId\":\"$AGENT\",\"sessionKey\":\"$key\"}" 2>&1)" || true
printf '%s' "$eff" | python3 -I -c '
import sys, json
allowed = set(json.loads(sys.argv[1]))
t = sys.stdin.read()
try:
    d = json.loads(t[t.find("{"):])
    tools = sorted({x["id"] for g in d["groups"] for x in g["tools"]})
except Exception:
    print("  FEHLER tools.effective nicht auswertbar"); sys.exit(1)
mcp_ok = {"gtads-coder__" + n for n in ("coder_prepare", "coder_stop", "coder_status", "coder_report", "coder_limits", "coder_reviews", "coder_review_findings",
                                         "coder_agents", "coder_released", "coder_start_released", "codex_plan", "codex_revise", "codex_drafts",
                                         "coder_health", "coder_costs", "codex_health", "codex_cancel")}
if any("approve" in x or "freigeb" in x for x in tools): print("  FEHLER Freigabe-Werkzeug beim Sprachmodell sichtbar"); sys.exit(1)
extra = [x for x in tools if x not in allowed and x not in mcp_ok]
print("  wirksame Werkzeuge: " + ", ".join(tools))
if "read" not in tools: print("  FEHLER read fehlt (Statusagent muss lesen koennen)"); sys.exit(1)
if extra: print("  FEHLER unerlaubte Werkzeuge: " + ", ".join(extra)); sys.exit(1)
print("  OK     nur lesende Werkzeuge wirksam")
' "$ALLOWED"
