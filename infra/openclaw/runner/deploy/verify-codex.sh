#!/usr/bin/env bash
# Prueft die Codex-Integration (lesend; mit --smoke zusaetzlich ein kleiner synthetischer Review, verbraucht etwas Kontingent).
#   sudo bash verify-codex.sh [--smoke]
set -Eeuo pipefail
cd /
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren." >&2; exit 1; }
SMOKE=0; [ "${1:-}" = "--smoke" ] && SMOKE=1
CUID="$(id -u occoder)"; FAIL=0
ok() { echo "  OK     $*"; }; bad() { echo "  FEHLER $*"; FAIL=1; }; info() { echo "  INFO   $*"; }
san() { sed -E 's/[A-Za-z0-9_-]{32,}/<x>/g; s/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<e-mail>/g'; }
oc() { runuser -u occoder -- env HOME=/var/lib/occoder XDG_RUNTIME_DIR="/run/user/$CUID" OPENCLAW_STATE_DIR=/var/lib/occoder/.openclaw \
  OPENCLAW_CONFIG_PATH=/var/lib/occoder/.openclaw/openclaw.json OPENCLAW_DISABLE_BONJOUR=1 CI=1 \
  HTTPS_PROXY=http://127.0.0.1:3128 HTTP_PROXY=http://127.0.0.1:3128 NODE_USE_ENV_PROXY=1 NO_PROXY=127.0.0.1,localhost,::1 \
  PATH=/opt/openclaw/node/bin:/usr/bin:/bin /opt/openclaw/node/bin/node /opt/openclaw/app/node_modules/openclaw/openclaw.mjs "$@"; }

echo "[1] Keine API-Abrechnung moeglich"
CODE="$(printf 'CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n' | timeout 10 python3 -I -c 'import socket,sys;s=socket.create_connection(("127.0.0.1",3128),5);s.sendall(sys.stdin.buffer.read());print(s.recv(200).decode(errors="replace").split("\r\n")[0])' 2>&1 || true)"
case "$CODE" in *" 200 "*|"") bad "api.openai.com wird NICHT abgelehnt: ${CODE:-keine Antwort}";; *) ok "Proxy lehnt api.openai.com ab ($CODE)";; esac
if systemctl show gt-ads-coding-runner -p Environment --value | grep -q -E 'OPENAI_API_KEY|CODEX_API_KEY'; then bad "API-Key-Variable in der Runner-Unit"; else ok "keine OpenAI-/Codex-API-Key-Variable in der Runner-Unit"; fi
ls /etc/gt-ads/runner-credentials | grep -q -i openai && bad "OpenAI-Datei in den Runner-Zugangsdaten" || ok "keine OpenAI-Zugangsdaten als Datei (nur OAuth im OpenClaw-Profil)"

echo "[2] Anmeldung (ChatGPT-OAuth, Reviewer-Agent)"
OUT="$(oc models auth list --provider openai --agent reviewer 2>&1 | san || true)"  # Ausgabe ohne E-Mail/Token
echo "$OUT" | head -8 | sed 's/^/    /'
echo "$OUT" | grep -q -i -E 'oauth|chatgpt|codex' && ok "OAuth-Profil fuer openai vorhanden" || bad "kein OAuth-Profil (zuerst: sudo bash infra/openclaw/runner/deploy/codex-login.sh)"
echo "$OUT" | grep -q -i 'api[-_ ]key' && bad "API-Key-Profil vorhanden (nicht erlaubt)" || ok "kein API-Key-Profil"

echo "[3] Modell"
MODEL="$(python3 -I -c 'import re;t=open("/var/lib/occoder/.openclaw/openclaw.json").read();m=re.search(r"\"?reviewer\"?\s*:\s*\{[^}]*?\"?model\"?\s*:\s*\"([^\"]+)\"",t,re.S);print(m.group(1) if m else "")' 2>/dev/null || true)"
info "konfiguriertes Reviewer-Modell: ${MODEL:-unbekannt}"
MODELS="$(oc models list --provider openai --refresh --agent reviewer 2>&1 | san || true)"
echo "$MODELS" | head -14 | sed 's/^/    /'
if [ -n "$MODEL" ] && echo "$MODELS" | grep -q -F "${MODEL#openai/}"; then ok "Modell im Katalog des Kontos gefunden"; else bad "Modell nicht im Katalog (anderes Modell in runner/config/openclaw-coder.json5.template waehlen und install-coder.sh erneut ausfuehren)"; fi

echo "[4] Kontingent (kontoweit, vom Anbieter gemeldet; nichts geschaetzt)"
python3 -I - <<'PY' || FAIL=1
import json, os, subprocess, sys, tempfile
sys.path.insert(0, "/opt/gt-ads/runner")
from quota import QuotaGate
cfg = json.load(open("/etc/gt-ads/runner.json"))
env = {"PATH": "/usr/bin:/bin", "HOME": cfg["home"], "XDG_RUNTIME_DIR": cfg["xdg_runtime_dir"], "OPENCLAW_STATE_DIR": cfg["home"] + "/.openclaw",
       "OPENCLAW_CONFIG_PATH": cfg["home"] + "/.openclaw/openclaw.json", "HTTPS_PROXY": "http://127.0.0.1:3128", "NODE_USE_ENV_PROXY": "1", "NO_PROXY": "127.0.0.1,localhost", "CI": "1", "OPENCLAW_DISABLE_BONJOUR": "1"}
def fetch():
    out = subprocess.run(["runuser", "-u", "occoder", "--", "env"] + ["%s=%s" % kv for kv in env.items()] + [cfg["openclaw_node"], cfg["openclaw_js"], "status", "--usage", "--json", "--agent", "reviewer"],
                         capture_output=True, text=True, timeout=150)
    return out.stdout
gate = QuotaGate(os.path.join(tempfile.mkdtemp(), "q.sqlite"), fetch, {k: v for k, v in (cfg.get("reviews") or {}).items() if k in ("limit_percent", "safety_margin_percent")})
d = gate.check()
if d["measurable"]:
    print("  OK     5-Stunden-Fenster messbar: %.1f %% genutzt (%.1f %% frei), Ruecksetzung %s" % (d["five_hour"]["used_percent"], d["five_hour"]["left_percent"], d["five_hour"]["reset_at"]))
    print("  OK     Wochenfenster messbar:     %.1f %% genutzt (%.1f %% frei), Ruecksetzung %s" % (d["week"]["used_percent"], d["week"]["left_percent"], d["week"]["reset_at"]))
    print("  INFO   Tarif: %s; Entscheidung: %s (%s)" % (d["plan"], "erlaubt" if d["allowed"] else "gesperrt", d["reason"]))
else:
    print("  FEHLER Kontingent nicht zuverlaessig messbar -> automatische Codex-Reviews bleiben GESPERRT: %s" % d["reason"])
    sys.exit(1)
PY

if [ "$SMOKE" -eq 1 ]; then
  echo "[5] Synthetischer Review (verbraucht einen kleinen Teil des Kontingents)"
  if runuser -u occoder -- env HOME=/var/lib/occoder XDG_RUNTIME_DIR="/run/user/$CUID" python3 -E -s /opt/gt-ads/runner/codex_smoke.py /etc/gt-ads/runner.json 2>&1 | san; then ok "synthetischer Review bestanden"; else bad "synthetischer Review nicht bestanden (Ausgabe oben)"; fi
fi
echo; [ "$FAIL" -eq 0 ] && echo "ERGEBNIS: bestanden" || echo "ERGEBNIS: NICHT bestanden - Codex-Reviews bleiben (durch das Gate) gesperrt"
exit "$FAIL"
