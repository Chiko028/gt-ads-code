#!/usr/bin/env bash
# Coding-Runner installieren (privilegiert). Voraussetzungen: WP-007 (OpenClaw, Proxy) und WP-008 (Podman, occoder, Image) sind erledigt.
#   sudo bash install-coder.sh [--dry-run]
# Aendert NICHT: SSH, UFW, Docker, bestehende OpenClaw-Konfiguration. Kein Telegram-Polling (der Runner sendet nur).
set -Eeuo pipefail

DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/.." && pwd)"
cd / # neutrales Arbeitsverzeichnis (Benutzer occoder darf das Repo nicht lesen)
umask 077
run() { if [ "$DRY" -eq 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
[ "$DRY" -eq 1 ] || [ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren (oder --dry-run)." >&2; exit 1; }
OC_STATE=/var/lib/occoder
OPENCLAW_VERSION=2026.11.2   # exakt wie in package.json/package-lock.json (WP-007)
NODE=/opt/openclaw/node/bin/node
OCJS=/opt/openclaw/app/node_modules/openclaw/openclaw.mjs
as_coder() { runuser -u occoder -- env HOME=$OC_STATE XDG_RUNTIME_DIR="/run/user/$CUID" OPENCLAW_STATE_DIR=$OC_STATE/.openclaw OPENCLAW_CONFIG_PATH=$OC_STATE/.openclaw/openclaw.json \
  OPENCLAW_DISABLE_BONJOUR=1 CI=1 PATH=/opt/openclaw/node/bin:/usr/bin:/bin "$@"; }

echo "1/6 Voraussetzungen pruefen"
if [ "$DRY" -eq 0 ]; then
  id occoder >/dev/null 2>&1 || { echo "Benutzer occoder fehlt (zuerst WP-008: setup-podman-sandbox.sh)." >&2; exit 1; }
  CUID="$(id -u occoder)"; CGID="$(id -g occoder)"
  as_coder podman image exists gtads-sandbox:1 || { echo "Sandbox-Image gtads-sandbox:1 fehlt (WP-008)." >&2; exit 1; }
  systemctl is-active --quiet gt-ads-egress-proxy.service || { echo "Egress-Proxy ist nicht aktiv." >&2; exit 1; }
  [ -x "$NODE" ] && [ -f "$OCJS" ] || { echo "OpenClaw (WP-007) ist nicht installiert." >&2; exit 1; }
  OPERATOR_ID="$(python3 -I -c 'import re,sys;m=re.search(r"allowFrom\"?\s*:\s*\[\s*\"?(\d+)",open(sys.argv[1]).read());print(m.group(1) if m else "")' /var/lib/openclaw/.openclaw/openclaw.json)"
  [ -n "$OPERATOR_ID" ] || { echo "Betreiber-ID aus der OpenClaw-Konfiguration nicht lesbar." >&2; exit 1; }
else CUID=OCCODER_UID; CGID=OCCODER_GID; OPERATOR_ID="<aus der OpenClaw-Konfiguration>"; fi

echo "2/6 Programmdateien nach /opt/gt-ads/runner (root-eigen, schreibgeschuetzt)"
run install -d -m 0755 -o root -g root /opt/gt-ads/runner /opt/gt-ads/runner/templates
for f in runner_core.py runner_daemon.py executors.py notifier.py mcp_server.py quota.py review_core.py codex_smoke.py gemini_review.py stack.py supply_check.py approvals.py planner_core.py planner_daemon.py redact.py; do run install -m 0644 -o root -g root "$SRC/$f" /opt/gt-ads/runner/$f; done
run cp -r "$SRC/templates/sandbox-demo" /opt/gt-ads/runner/templates/
# Lesbar fuer occoder machen: das Skript laeuft mit umask 077, cp -r uebernimmt sonst 0700/0600 (Ursache des PermissionError beim ersten Pilotlauf)
run chown -R root:root /opt/gt-ads/runner; run chmod -R u=rwX,go=rX /opt/gt-ads/runner

echo "3/6 Zugangsdaten (Kopie der vorhandenen, root 0600; nie ausgegeben)"
run install -d -m 0700 -o root -g root /etc/gt-ads/runner-credentials
for c in telegram_bot_token deepseek_api_key; do run install -m 0600 -o root -g root /etc/gt-ads/openclaw-credentials/$c /etc/gt-ads/runner-credentials/$c; done
# Gemini-Schluessel: leere Platzhalterdatei (die Unit laedt die Datei immer); den echten Schluessel legt der Betreiber mit set-gemini-key.sh ab. Vorhandene bleibt unveraendert.
if [ "$DRY" -eq 1 ]; then echo "[dry-run] /etc/gt-ads/runner-credentials/gemini_api_key anlegen (leer), falls nicht vorhanden"
elif [ ! -e /etc/gt-ads/runner-credentials/gemini_api_key ]; then install -m 0600 -o root -g root /dev/null /etc/gt-ads/runner-credentials/gemini_api_key; fi

# Egress-Allowlist (WP-011: auth.openai.com, chatgpt.com; api.openai.com bleibt gesperrt). Proxy nur neu starten, wenn sich die Datei aendert.
ALLOW_SRC="$SRC/../config/egress-allowlist.txt"
if [ "$DRY" -eq 1 ]; then echo "[dry-run] /etc/gt-ads/egress-allowlist.txt aktualisieren (falls geaendert) und gt-ads-egress-proxy neu starten"
elif ! cmp -s "$ALLOW_SRC" /etc/gt-ads/egress-allowlist.txt; then
  install -m 0644 -o root -g root "$ALLOW_SRC" /etc/gt-ads/egress-allowlist.txt
  systemctl restart gt-ads-egress-proxy.service
  sleep 2; systemctl is-active --quiet gt-ads-egress-proxy.service || { echo "Egress-Proxy startet nicht - Allowlist pruefen" >&2; exit 1; }
  echo "Egress-Allowlist aktualisiert, Proxy neu gestartet."
fi

echo "4/6 Konfiguration und Zustand (occoder)"
if [ "$DRY" -eq 1 ]; then echo "[dry-run] /etc/gt-ads/runner.json rendern (Betreiber-ID, UID); $OC_STATE/{runner,specs,workspace,.openclaw}; Coder-Konfiguration rendern; DeepSeek-Plugin als occoder installieren"
else
  python3 -I - "$SRC/config/runner.json" "$OPERATOR_ID" "$CUID" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
cfg["operator_chat_id"] = int(sys.argv[2])
cfg["xdg_runtime_dir"] = "/run/user/" + sys.argv[3]
import pwd
try:  # Freigabebereich nur, wenn der Planer (ocplan) installiert ist; der Runner prueft Besitzer + Rechte jeder Freigabedatei
    cfg["release_owner_uid"] = pwd.getpwnam("ocplan").pw_uid
except KeyError:
    cfg.pop("release_dir", None)
json.dump(cfg, open("/etc/gt-ads/runner.json", "w"), indent=2)
PY
  chmod 0644 /etc/gt-ads/runner.json
  install -d -m 0700 -o occoder -g occoder $OC_STATE/runner $OC_STATE/workspace $OC_STATE/.openclaw $OC_STATE/artifacts $OC_STATE/integration
  install -d -m 0755 -o root -g root $OC_STATE/seeds
  install -d -m 0755 -o root -g root $OC_STATE/specs
  sed -e "s#__WORKSPACE__#$OC_STATE/workspace#" -e "s/__UID__/$CUID/" -e "s/__GID__/$CGID/" "$SRC/config/openclaw-coder.json5.template" > $OC_STATE/.openclaw/openclaw.json
  chown occoder:occoder $OC_STATE/.openclaw/openclaw.json; chmod 0600 $OC_STATE/.openclaw/openclaw.json
  if ! as_coder "$NODE" "$OCJS" plugins list 2>/dev/null | grep -qi deepseek; then
    as_coder "$NODE" "$OCJS" config set proxy.enabled false   # Plugin-Download einmalig direkt (Proxy erlaubt die npm-Registry nicht)
    trap 'as_coder "$NODE" "$OCJS" config set proxy.enabled true' EXIT
    as_coder "$NODE" "$OCJS" plugins install "@openclaw/deepseek-provider@$OPENCLAW_VERSION"
    as_coder "$NODE" "$OCJS" config set proxy.enabled true; trap - EXIT
  fi
  as_coder "$NODE" "$OCJS" config validate
fi

echo "5/6 Spezifikationen spiegeln (nur docs/ARBEITSPAKETE aus main)"
run bash "$HERE/sync-runner-specs.sh"

echo "6/6 Dienst installieren und starten"
if [ "$DRY" -eq 1 ]; then echo "[dry-run] gt-ads-coding-runner.service installieren (UID eintragen), enable --now"
else
  sed "s/OCCODER_UID/$CUID/g" "$HERE/gt-ads-coding-runner.service" > /etc/systemd/system/gt-ads-coding-runner.service; chmod 0644 /etc/systemd/system/gt-ads-coding-runner.service
  systemctl daemon-reload
  WAS_ACTIVE=0; systemctl is-active --quiet gt-ads-coding-runner.service && WAS_ACTIVE=1
  systemctl enable --now gt-ads-coding-runner.service
  # Ein bereits laufender Dienst haelt den alten Code im Speicher: neu starten, aber nie mitten in einem laufenden Auftrag.
  if [ "$WAS_ACTIVE" -eq 1 ]; then
    if python3 -I -c 'import sys,json; sys.path.insert(0,"/opt/gt-ads/runner"); import mcp_server; r=mcp_server.call_runner({"cmd":"status"}); sys.exit(1 if any(j["state"]=="running" for j in r["result"]["jobs"]) else 0)' 2>/dev/null; then
      systemctl restart gt-ads-coding-runner.service; echo "Runner neu gestartet (neuer Code aktiv)."
    else echo "Runner NICHT neu gestartet: ein Auftrag laeuft (oder Status nicht lesbar). Nach dessen Ende: sudo systemctl restart gt-ads-coding-runner"; fi
  fi
  for _ in $(seq 1 30); do [ -S /run/gtads-runner/control.sock ] && break; sleep 2; done
  [ -S /run/gtads-runner/control.sock ] || { echo "Steuer-Socket erscheint nicht - Dienst pruefen (journalctl -u gt-ads-coding-runner)" >&2; exit 1; }
  echo "Runner laeuft. Status:"; python3 -I -c 'import sys; sys.path.insert(0,"/opt/gt-ads/runner"); import mcp_server, json; print(json.dumps(mcp_server.call_runner({"cmd":"status"}), ensure_ascii=False)[:400])'
fi
echo "Fertig. Codex-Reviews bleiben gesperrt, bis die Anmeldung steht und das Kontingent messbar ist: sudo bash $HERE/codex-login.sh, danach sudo bash $HERE/verify-codex.sh"
