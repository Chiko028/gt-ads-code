#!/usr/bin/env bash
# Rein LESENDE Diagnose des Coding-Runners (aendert nichts, startet nichts, ruft kein Modell auf).
#   sudo bash diagnose-runner.sh   -> bereinigter Bericht nach /tmp/runner-diag.txt (lesbar fuer alle)
set -Eeuo pipefail
cd /
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren." >&2; exit 1; }
OUT=/tmp/runner-diag.txt
U=gt-ads-coding-runner.service
san() { sed -E 's/[A-Za-z0-9_-]{32,}/<x>/g'; }
as_coder() { runuser -u occoder -- env HOME=/var/lib/occoder XDG_RUNTIME_DIR="/run/user/$(id -u occoder)" PATH=/usr/bin:/bin "$@"; }
{
echo "== Dienst =="; date
systemctl show $U -p ActiveState,SubState,NRestarts,ActiveEnterTimestamp,Result,ExecMainStatus,MemoryCurrent,MemoryPeak
echo "== Auftraege und Verbrauch (Runner-Status ueber den Steuer-Socket) =="
python3 -I -c 'import sys,json; sys.path.insert(0,"/opt/gt-ads/runner"); import mcp_server; print(json.dumps(mcp_server.call_runner({"cmd":"status"}), ensure_ascii=False, indent=1)[:1500])' 2>&1 | head -40
echo "== Letzter Bericht =="
python3 -I -c 'import sys,json; sys.path.insert(0,"/opt/gt-ads/runner"); import mcp_server; print(json.dumps(mcp_server.call_runner({"cmd":"report"}), ensure_ascii=False, indent=1)[:2500])' 2>&1 | head -50
echo "== Codex-Kontingent: Entscheidung des laufenden Runners (limits) =="
START=$(date +%s)
timeout 200 python3 -I - <<'PY' 2>&1 | head -40
import json, socket
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.settimeout(180)  # die Kontingentabfrage startet die OpenClaw-CLI und kann lange dauern
sock.connect("/run/gtads-runner/control.sock")
sock.sendall(b'{"cmd": "limits"}\n')
buf = b""
while not buf.endswith(b"\n"):
    chunk = sock.recv(65536)
    if not chunk:
        break
    buf += chunk
print(json.dumps(json.loads(buf), ensure_ascii=False, indent=1)[:1800])
PY
echo "(Dauer der Abfrage: $(( $(date +%s) - START )) s)"
echo "== Kontingent-Messprotokoll (letzte 8 Messungen, ohne Geheimnisse) =="
python3 -I - <<'PY' 2>&1 | head -12
import sqlite3, time
c = sqlite3.connect("file:/var/lib/occoder/runner/runner.sqlite?mode=ro", uri=True)
try:
    for ts, allowed, five, week, plan, reason in c.execute("SELECT ts, allowed, five_used, week_used, plan, substr(reason,1,160) FROM quota_log ORDER BY id DESC LIMIT 8"):
        print(time.strftime("%H:%M:%S", time.localtime(ts)), "erlaubt" if allowed else "gesperrt", five, week, plan, reason)
except Exception as exc:
    print("keine Messungen:", exc.__class__.__name__)
PY
echo "== Audit-Ereignisse (ohne Inhalte) =="
python3 -I - <<'PY' 2>&1 | head -30
import sqlite3, time
c = sqlite3.connect("file:/var/lib/occoder/runner/runner.sqlite?mode=ro", uri=True)
for ts, job, ev, detail in c.execute("SELECT ts, job_id, event, substr(detail,1,80) FROM audit ORDER BY id DESC LIMIT 15"):
    print(time.strftime("%H:%M:%S", time.localtime(ts)), job, ev, detail)
PY
echo "== Journal Runner (30 min, gefiltert) =="
journalctl -u $U --since "-30min" --no-pager 2>/dev/null | grep -v -i -E 'token|api_key|bot[0-9]+:' | cut -c1-260 | san | tail -40
echo "== Container und Workspace (occoder) =="
as_coder podman ps -a --format '{{.ID}} {{.Status}} {{.Image}}' 2>&1 | head -5
ls -la /var/lib/occoder/workspace 2>&1 | head -15
as_coder git -C /var/lib/occoder/workspace -c core.hooksPath=/dev/null log --oneline -5 2>&1 | head -6
echo "== Speicher =="; df -h /var/lib | tail -1; free -m | sed -n 2p
} > "$OUT" 2>&1
chmod 644 "$OUT"
echo "Bericht: $OUT ($(wc -l < "$OUT") Zeilen) - ohne Schluessel und ohne Nachrichteninhalte."
