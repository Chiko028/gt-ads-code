#!/usr/bin/env bash
# Rein LESENDE Diagnose des OpenClaw-Dienstes. Aendert nichts, startet nichts, ruft kein Modell auf.
#   sudo bash diagnose-openclaw.sh      -> schreibt einen bereinigten Bericht nach /tmp/oc-diag.txt (lesbar fuer alle)
set -Eeuo pipefail
cd /
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren." >&2; exit 1; }
OUT=/tmp/oc-diag.txt
U=gt-ads-openclaw.service
CG=/sys/fs/cgroup/system.slice/$U
STATE=/var/lib/openclaw/.openclaw
san() { sed -E 's/[A-Za-z0-9_-]{32,}/<x>/g'; }
oc() { runuser -u openclaw -- env HOME=/var/lib/openclaw OPENCLAW_STATE_DIR=$STATE OPENCLAW_CONFIG_PATH=$STATE/openclaw.json OPENCLAW_DISABLE_BONJOUR=1 CI=1 \
  PATH=/opt/openclaw/node/bin:/usr/bin:/bin /opt/openclaw/node/bin/node /opt/openclaw/app/node_modules/openclaw/openclaw.mjs "$@"; }
{
echo "== Zeit/Dienst =="; date
systemctl show $U -p ActiveState,SubState,NRestarts,ActiveEnterTimestamp,User,Group,CPUQuotaPerSecUSec,MemoryMax,MemoryCurrent,MemoryPeak,TasksCurrent,Result,ExecMainStatus
echo "== cgroup: CPU-Drosselung und Speicher =="
cat $CG/cpu.stat | grep -E 'nr_periods|nr_throttled|throttled_usec|usage_usec'; cat $CG/cpu.max; cat $CG/memory.events 2>/dev/null; cat $CG/memory.max $CG/memory.high 2>/dev/null
echo "== Readiness-Endpunkte (HTTP-Code, JSON) =="
for p in healthz startupz readyz; do printf '%s: ' "$p"; curl -s -m 10 -w ' [HTTP %{http_code}]\n' "http://127.0.0.1:18789/$p" | head -c 900; done
echo "== Journal (15 min, gefiltert, ohne Nachrichteninhalte) =="
journalctl -u $U --since "-15min" --no-pager 2>/dev/null \
  | grep -i -E 'agent-database-inspection|startup inspection|preparation|sqlite|SQLITE|EACCES|permission denied|locked|BUSY|schema|migrat|ready|failed|error|OOM|killed|Scheduled restart|Started|Stopping|Main process exited' \
  | grep -v -i -E 'bot[0-9]+:|api_key|token' | cut -c1-300 | san | tail -60
echo "== Startphasen > 5 s (15 min) =="
journalctl -u $U --since "-15min" --no-pager 2>/dev/null | grep -E 'startup phase: .* [0-9]{4,}\.[0-9]ms' | grep -v starting | cut -c1-260 | san | tail -25
echo "== Dateisystem =="
namei -l $STATE/agents/status/agent/openclaw-agent.sqlite 2>&1 | tail -12
ls -la $STATE/agents/status/agent/ 2>&1 | head -20
df -h /var/lib | tail -1; free -m | sed -n 2p
echo "== Sandbox-Einstellungen der Unit =="
systemctl show $U -p ProtectSystem,ProtectHome,PrivateTmp,ReadWritePaths,ReadOnlyPaths,StateDirectory,NoNewPrivileges,SystemCallFilter,RestrictNamespaces | cut -c1-200
echo "== openclaw doctor --lint --json (schreibgeschuetzt, als Dienstbenutzer) =="
timeout 240 oc doctor --lint --json 2>&1 | san | head -c 6000
} > "$OUT" 2>&1
chmod 644 "$OUT"
echo "Bericht: $OUT ($(wc -l < "$OUT") Zeilen) - enthaelt keine Schluessel; bitte Claude Bescheid geben."
