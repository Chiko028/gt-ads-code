#!/usr/bin/env bash
# Codex-Planer + Freigabebereich + Telegram-Freigabe-Plugin installieren (privilegiert; NEUE Dienstidentitaet -> gesonderte Freigabe des Betreibers).
#   sudo bash install-planner.sh [--dry-run]
# Legt an: Systembenutzer ocplan (ohne Login-Shell), Planungsbereich /var/lib/gt-ads-plan (0700 ocplan), Freigabebereich /var/lib/gt-ads-release
# (0755 ocplan; fuer den Runner nur lesbar), /etc/gt-ads/planner.json, /etc/gt-ads/planner-credentials (nur Telegram-Bot-Token zum Senden),
# gt-ads-planner.service, Plugin-Dateien unter /opt/gt-ads/openclaw-plugins/gtads-freigabe.
# Aendert NICHT: SSH, UFW, Docker, sudoers, Ports (nur Unix-Sockets). Keine neuen kostenpflichtigen Dienste.
set -Eeuo pipefail
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/.." && pwd)"
PLUGIN_SRC="$(cd "$SRC/../plugins/gtads-freigabe" && pwd)"
cd /
umask 077
run() { if [ "$DRY" -eq 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
[ "$DRY" -eq 1 ] || [ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren (oder --dry-run)." >&2; exit 1; }
PLAN=/var/lib/gt-ads-plan
REL=/var/lib/gt-ads-release
NODE=/opt/openclaw/node/bin/node
OCJS=/opt/openclaw/app/node_modules/openclaw/openclaw.mjs
as_plan() { runuser -u ocplan -- env HOME=$PLAN OPENCLAW_STATE_DIR=$PLAN/.openclaw OPENCLAW_CONFIG_PATH=$PLAN/.openclaw/openclaw.json \
  OPENCLAW_DISABLE_BONJOUR=1 CI=1 PATH=/opt/openclaw/node/bin:/usr/bin:/bin "$@"; }

echo "1/7 Voraussetzungen"
if [ "$DRY" -eq 0 ]; then
  systemctl is-active --quiet gt-ads-egress-proxy.service || { echo "Egress-Proxy ist nicht aktiv." >&2; exit 1; }
  [ -x "$NODE" ] && [ -f "$OCJS" ] || { echo "OpenClaw (WP-007) ist nicht installiert." >&2; exit 1; }
  OPERATOR_ID="$(python3 -I -c 'import re,sys;m=re.search(r"allowFrom\"?\s*:\s*\[\s*\"?(\d+)",open(sys.argv[1]).read());print(m.group(1) if m else "")' /var/lib/openclaw/.openclaw/openclaw.json)"
  [ -n "$OPERATOR_ID" ] || { echo "Betreiber-ID aus der OpenClaw-Konfiguration nicht lesbar." >&2; exit 1; }
else OPERATOR_ID="<aus der OpenClaw-Konfiguration>"; fi

echo "2/7 Dienstidentitaet ocplan (System-Benutzer, keine Login-Shell, keine sudo-Rechte, eigene Gruppe)"
if [ "$DRY" -eq 1 ]; then echo "[dry-run] useradd --system --user-group --home-dir $PLAN --no-create-home --shell /usr/sbin/nologin ocplan (falls fehlend)"
elif ! id ocplan >/dev/null 2>&1; then useradd --system --user-group --home-dir $PLAN --no-create-home --shell /usr/sbin/nologin ocplan; fi
# Socket-Gruppe fuer die Planer-Sockets: nur openclaw (Gateway) wird Mitglied; occoder (Runner/DeepSeek) nie.
if [ "$DRY" -eq 1 ]; then echo "[dry-run] groupadd --system gtads-plan-ctl; usermod -aG gtads-plan-ctl openclaw (wirksam nach Gateway-Neustart)"
else
  getent group gtads-plan-ctl >/dev/null || groupadd --system gtads-plan-ctl
  id -nG openclaw | tr ' ' '\n' | grep -qx gtads-plan-ctl || usermod -aG gtads-plan-ctl openclaw
  if id -nG occoder 2>/dev/null | tr ' ' '\n' | grep -qx gtads-plan-ctl; then echo "occoder ist in gtads-plan-ctl - Abbruch (Isolation)." >&2; exit 1; fi
fi
if [ "$DRY" -eq 0 ]; then
  for g in openclaw occoder sudo adm systemd-journal docker; do
    if id -nG ocplan | tr ' ' '\n' | grep -qx "$g"; then echo "ocplan ist dauerhaft in Gruppe $g - Abbruch (Isolation)." >&2; exit 1; fi
  done
fi

echo "3/7 Planungsbereich (0700 ocplan) und Freigabebereich (0755 ocplan, Runner nur lesend)"
run install -d -m 0700 -o ocplan -g ocplan $PLAN $PLAN/.openclaw $PLAN/prompts $PLAN/ws
run install -d -m 0755 -o root -g root $PLAN/seeds
run install -d -m 0755 -o ocplan -g ocplan $REL

echo "4/7 Programmdateien (root-eigen) und Plugin"
for f in planner_core.py planner_daemon.py approvals.py redact.py runner_daemon.py runner_core.py quota.py executors.py notifier.py gemini_review.py review_core.py stack.py supply_check.py; do run install -m 0644 -o root -g root "$SRC/$f" /opt/gt-ads/runner/$f; done
run install -m 0755 -o root -g root "$HERE/gtads-confirm" /usr/local/sbin/gtads-confirm
run install -d -m 0755 -o root -g root /opt/gt-ads/openclaw-plugins /opt/gt-ads/openclaw-plugins/gtads-freigabe
for f in index.mjs openclaw.plugin.json package.json; do run install -m 0644 -o root -g root "$PLUGIN_SRC/$f" /opt/gt-ads/openclaw-plugins/gtads-freigabe/$f; done

echo "5/7 Konfiguration, Zugangsdaten (nur Bot-Token zum Senden), Seed"
run install -d -m 0700 -o root -g root /etc/gt-ads/planner-credentials
run install -m 0600 -o root -g root /etc/gt-ads/openclaw-credentials/telegram_bot_token /etc/gt-ads/planner-credentials/telegram_bot_token
if [ "$DRY" -eq 1 ]; then echo "[dry-run] /etc/gt-ads/planner.json rendern; Planer-OpenClaw-Konfiguration rendern und pruefen; Seed aus main"
else
  python3 -I - "$SRC/config/planner.json" "$OPERATOR_ID" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
cfg["operator_chat_id"] = int(sys.argv[2])
json.dump(cfg, open("/etc/gt-ads/planner.json", "w"), indent=2)
PY
  chmod 0644 /etc/gt-ads/planner.json
  sed -e "s#__WORKSPACE__#$PLAN/ws#" "$SRC/config/openclaw-planner.json5.template" > $PLAN/.openclaw/openclaw.json
  chown ocplan:ocplan $PLAN/.openclaw/openclaw.json; chmod 0600 $PLAN/.openclaw/openclaw.json
  as_plan "$NODE" "$OCJS" config validate
  bash "$HERE/sync-runner-specs.sh"
fi

echo "6/7 Dienst installieren und starten"
if [ "$DRY" -eq 1 ]; then echo "[dry-run] gt-ads-planner.service installieren, enable --now"
else
  install -m 0644 -o root -g root "$HERE/gt-ads-planner.service" /etc/systemd/system/gt-ads-planner.service
  systemctl daemon-reload
  systemctl enable --now gt-ads-planner.service
  systemctl restart gt-ads-planner.service
  for _ in $(seq 1 20); do [ -S /run/gtads-planner/approve.sock ] && break; sleep 1; done
  [ -S /run/gtads-planner/approve.sock ] || { echo "Planer-Sockets erscheinen nicht (journalctl -u gt-ads-planner)" >&2; exit 1; }
fi

echo "7/7 Naechste Schritte (Betreiber)"
echo "  a) Runner mit Freigabebereich neu installieren:        sudo bash $HERE/install-coder.sh"
echo "  b) Gateway mit Plugin neu rendern/starten (WP-007):    sudo bash $SRC/../deploy/install.sh"
echo "  c) Codex-Anmeldung NUR fuer den Planer (Device-Code):  sudo bash $HERE/codex-login.sh --planner"
echo "  d) Negative Zugriffstests:                             sudo bash $HERE/verify-isolation.sh"
