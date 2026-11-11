#!/usr/bin/env bash
# GT-Ads OpenClaw (Phase A: Chat- und Statusagent): Einrichtung. NUR durch den Betreiber mit sudo, nach ausdruecklicher Freigabe.
#   sudo bash install.sh --dry-run   # zeigt nur, was passieren wuerde (ohne root moeglich)
#   sudo bash install.sh             # installiert/aktualisiert OpenClaw; der Telegram-Schalter bleibt, wie er ist
# Voraussetzungen: Credentials unter /etc/gt-ads/credentials oder bereits unter /etc/gt-ads/openclaw-credentials. Das Python-Gateway wird nicht mehr verwendet.
# Tut NICHT: Firewall/UFW/SSH aendern, Ports oeffnen, Telegram umschalten (dafuer: switch-telegram-to-openclaw.sh),
#            Coding-Agent aktivieren (gesperrt, siehe docs/ARBEITSPAKETE/WP-007).
# Legt an: Benutzer `openclaw` und `gtads-egress` (system, ohne Login, ohne sudo, ohne docker-Gruppe).
set -Eeuo pipefail

DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $arg" >&2; exit 2 ;;
  esac
done
run() { if [ "$DRY" -eq 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
as_oc() { runuser -u openclaw -- env HOME=/var/lib/openclaw OPENCLAW_STATE_DIR=/var/lib/openclaw/.openclaw \
  OPENCLAW_CONFIG_PATH=/var/lib/openclaw/.openclaw/openclaw.json OPENCLAW_DISABLE_BONJOUR=1 CI=1 \
  PATH=/opt/openclaw/node/bin:/usr/bin:/bin "$@"; }

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd / # Arbeitsverzeichnis neutral: Benutzer openclaw darf das Repo-Verzeichnis nicht lesen (EACCES)
NODE_VERSION=v24.22.2
NODE_TARBALL="node-${NODE_VERSION}-linux-x64.tar.xz"
NODE_SHA256=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75   # nodejs.org SHASUMS256.txt (2026-11-09)
OPENCLAW_VERSION=2026.11.2
OLD_CRED=/etc/gt-ads/credentials
NEW_CRED=/etc/gt-ads/openclaw-credentials

if [ "$DRY" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then echo "Bitte mit sudo ausfuehren (oder --dry-run)." >&2; exit 1; fi

# --- Vorpruefungen (aendern nichts) --------------------------------------------------------
for cmd in curl tar xz python3 runuser systemctl sha256sum install; do command -v "$cmd" >/dev/null || { echo "Benoetigt: $cmd" >&2; exit 1; }; done
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' || { echo "Python >= 3.11 noetig" >&2; exit 1; }
for f in package.json package-lock.json .npmrc config/openclaw.json5.template config/egress-allowlist.txt \
         config/workspace-status/AGENTS.md egress-proxy/egress_proxy.py deploy/gt-ads-openclaw.service \
         deploy/gt-ads-egress-proxy.service deploy/start-gateway.sh deploy/guard-no-double-polling.sh; do
  [ -f "$SRC/$f" ] || { echo "Datei fehlt im Repo: $f" >&2; exit 1; }
done
if [ "$DRY" -eq 0 ]; then
  for f in telegram_bot_token deepseek_api_key; do
    [ -s "$OLD_CRED/$f" ] || [ -s "$NEW_CRED/$f" ] || { echo "Credential $f fehlt (weder $OLD_CRED noch $NEW_CRED)" >&2; exit 1; }
  done
  # Betreiber-ID: bevorzugt aus der vorhandenen OpenClaw-Konfiguration (das Python-Gateway und seine TOML-Datei wurden entfernt)
  ALLOWED_ID=""
  [ -f /var/lib/openclaw/.openclaw/openclaw.json ] && ALLOWED_ID="$(python3 -I -c 'import re,sys;m=re.search(r"allowFrom\"?\s*:\s*\[\s*\"?(\d+)",open(sys.argv[1]).read());print(m.group(1) if m else "")' /var/lib/openclaw/.openclaw/openclaw.json)"
  if [ -z "$ALLOWED_ID" ] && [ -f /etc/gt-ads/telegram-gateway.toml ]; then
    ALLOWED_ID="$(python3 -c 'import tomllib,sys; print(int(tomllib.load(open("/etc/gt-ads/telegram-gateway.toml","rb")).get("allowed_user_id",0)))')"
  fi
  [ -n "$ALLOWED_ID" ] && [ "$ALLOWED_ID" -gt 0 ] || { echo "Betreiber-ID weder in der OpenClaw-Konfiguration noch in telegram-gateway.toml gefunden" >&2; exit 1; }
else
  ALLOWED_ID="<aus der OpenClaw-Konfiguration>"
fi

# --- Benutzer (keine Login-Shell, kein sudo, keine Gruppen) --------------------------------------
id openclaw >/dev/null 2>&1 || run useradd --system --home-dir /var/lib/openclaw --no-create-home --shell /usr/sbin/nologin --user-group openclaw
id gtads-egress >/dev/null 2>&1 || run useradd --system --no-create-home --shell /usr/sbin/nologin --user-group gtads-egress

# --- Node.js (gepinnt, Pruefsumme) -----------------------------------------------------------
if [ ! -x /opt/openclaw/node/bin/node ] || [ "$(/opt/openclaw/node/bin/node --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  TMP="$(mktemp -d)"
  run curl -fsSL --max-time 300 -o "$TMP/$NODE_TARBALL" "https://nodejs.org/dist/$NODE_VERSION/$NODE_TARBALL"
  if [ "$DRY" -eq 0 ]; then echo "$NODE_SHA256  $TMP/$NODE_TARBALL" | sha256sum -c - || { echo "Pruefsumme Node.js falsch - Abbruch" >&2; exit 1; }; fi
  run install -d -m 0755 -o root -g root /opt/openclaw /opt/openclaw/node /opt/openclaw/bin
  run rm -rf /opt/openclaw/node
  run install -d -m 0755 -o root -g root /opt/openclaw/node
  run tar -xJf "$TMP/$NODE_TARBALL" -C /opt/openclaw/node --strip-components=1 --no-same-owner
  run rm -rf "$TMP"
fi

# --- OpenClaw (exakte Version per Lockdatei; nur das Skript von openclaw darf laufen, siehe .npmrc) ------
run install -d -m 0755 -o root -g root /opt/openclaw/app /opt/openclaw/bin
run install -m 0644 -o openclaw -g openclaw "$SRC/package.json" "$SRC/package-lock.json" "$SRC/.npmrc" /opt/openclaw/app/
run chown openclaw:openclaw /opt/openclaw/app
if [ "$DRY" -eq 1 ] || [ ! -f /opt/openclaw/app/node_modules/openclaw/openclaw.mjs ] \
   || [[ "$(as_oc /opt/openclaw/node/bin/node /opt/openclaw/app/node_modules/openclaw/openclaw.mjs --version 2>/dev/null | head -1 || true)" != "OpenClaw $OPENCLAW_VERSION"* ]]; then
  run runuser -u openclaw -- env HOME=/tmp/openclaw-npm PATH=/opt/openclaw/node/bin:/usr/bin:/bin npm_config_cache=/tmp/openclaw-npm/cache \
      npm ci --prefix /opt/openclaw/app
fi
run chown -R root:root /opt/openclaw/app
run chmod -R go-w /opt/openclaw
run rm -rf /tmp/openclaw-npm

# --- Egress-Proxy und Skripte ----------------------------------------------------------------------
run install -d -m 0755 -o root -g root /opt/gt-ads/egress-proxy /etc/gt-ads
run install -m 0644 -o root -g root "$SRC/egress-proxy/egress_proxy.py" /opt/gt-ads/egress-proxy/egress_proxy.py
[ -f /etc/gt-ads/egress-allowlist.txt ] || run install -m 0644 -o root -g root "$SRC/config/egress-allowlist.txt" /etc/gt-ads/egress-allowlist.txt
run install -m 0755 -o root -g root "$SRC/deploy/start-gateway.sh" "$SRC/deploy/guard-no-double-polling.sh" /opt/openclaw/bin/

# --- Credentials (kopiert aus dem bestehenden Verzeichnis; Werte werden nie ausgegeben) --------------------
run install -d -m 0700 -o root -g root "$NEW_CRED"
for f in telegram_bot_token deepseek_api_key; do
  [ -s "$NEW_CRED/$f" ] || run install -m 0600 -o root -g root "$OLD_CRED/$f" "$NEW_CRED/$f"
done
if [ "$DRY" -eq 1 ]; then echo "[dry-run] Gateway-Token erzeugen -> $NEW_CRED/gateway_token (0600 root)"
elif [ ! -s "$NEW_CRED/gateway_token" ]; then
  ( umask 077; python3 -c 'import secrets,sys; sys.stdout.write(secrets.token_urlsafe(48))' > "$NEW_CRED/gateway_token" )
  chown root:root "$NEW_CRED/gateway_token"; chmod 0600 "$NEW_CRED/gateway_token"
fi

# --- Zustand, Konfiguration, Arbeitsbereich -----------------------------------------------------------
run install -d -m 0700 -o openclaw -g openclaw /var/lib/openclaw /var/lib/openclaw/.openclaw /var/lib/openclaw/workspace-status
CFG=/var/lib/openclaw/.openclaw/openclaw.json
# Konfiguration immer aus der Vorlage rendern (die Vorlage ist die einzige Quelle der Wahrheit); der Telegram-Schalter bleibt, wie er ist.
telegram_active() { [ -f "$CFG" ] && python3 -I -c 'import re,sys;m=re.search(r"telegram\"?\s*:\s*\{[^{}]*?enabled\"?\s*:\s*(true|false)",open(sys.argv[1]).read());sys.exit(0 if m and m.group(1)=="true" else 1)' "$CFG" 2>/dev/null; }
if [ "$DRY" -eq 1 ]; then echo "[dry-run] Konfiguration aus Vorlage rendern (Telegram-Schalter wie bisher; Sicherung als openclaw.json.bak) -> $CFG"
else
  TG=false; telegram_active && TG=true
  [ -f "$CFG" ] && install -m 0600 -o openclaw -g openclaw "$CFG" "$CFG.bak"
  sed -e "s/__TELEGRAM_ENABLED__/$TG/" -e "s/__ALLOWED_USER_ID__/$ALLOWED_ID/" "$SRC/config/openclaw.json5.template" > "$CFG"
  chown openclaw:openclaw "$CFG"; chmod 0600 "$CFG"; CONFIG_RENDERED=1
fi
run install -m 0644 -o openclaw -g openclaw "$SRC/config/workspace-status/AGENTS.md" /var/lib/openclaw/workspace-status/AGENTS.md

# --- DeepSeek-Provider-Plugin (offizielles Paket, exakte Version) ---------------------------------------
if [ "$DRY" -eq 1 ]; then echo "[dry-run] openclaw plugins install @openclaw/deepseek-provider@$OPENCLAW_VERSION (als Benutzer openclaw)"
elif ! as_oc /opt/openclaw/node/bin/node /opt/openclaw/app/node_modules/openclaw/openclaw.mjs plugins list 2>/dev/null | grep -qi 'deepseek'; then
  # Einmaliger Download direkt von der npm-Registry (exakte Version): Der Egress-Proxy laeuft hier noch nicht und
  # erlaubt die Registry bewusst nicht. Proxy-Einstellung nur fuer diesen Schritt aus, danach sofort wieder an.
  OCJS="/opt/openclaw/app/node_modules/openclaw/openclaw.mjs"
  as_oc /opt/openclaw/node/bin/node "$OCJS" config set proxy.enabled false
  restore_proxy() { as_oc /opt/openclaw/node/bin/node "$OCJS" config set proxy.enabled true; }
  trap restore_proxy EXIT
  as_oc /opt/openclaw/node/bin/node "$OCJS" plugins install "@openclaw/deepseek-provider@$OPENCLAW_VERSION"
  restore_proxy; trap - EXIT
fi

# --- Validierung ---------------------------------------------------------------------------------------
if [ "$DRY" -eq 0 ]; then
  as_oc /opt/openclaw/node/bin/node /opt/openclaw/app/node_modules/openclaw/openclaw.mjs config validate
  # Das Gateway-Token liefert systemd nur dem laufenden Dienst (LoadCredential). Ohne Token meldet der Audit faelschlich
  # "gateway auth missing" (2026-11-11 beobachtet; im Wegwerf-Lauf belegt). Deshalb wie im Dienst ueber die Umgebung uebergeben:
  # nur in dieser Subshell, nie in Befehlszeilen (ps) oder Ausgaben.
  (
    if [ -r /etc/gt-ads/openclaw-credentials/gateway_token ]; then OPENCLAW_GATEWAY_TOKEN="$(</etc/gt-ads/openclaw-credentials/gateway_token)"; export OPENCLAW_GATEWAY_TOKEN; fi
    as_oc /opt/openclaw/node/bin/node /opt/openclaw/app/node_modules/openclaw/openclaw.mjs security audit || true
  )
fi

# --- Units, Schutz vor doppeltem Polling, Start OHNE Telegram ------------------------------------------------
run install -m 0644 -o root -g root "$SRC/deploy/gt-ads-egress-proxy.service" /etc/systemd/system/gt-ads-egress-proxy.service
run install -m 0644 -o root -g root "$SRC/deploy/gt-ads-openclaw.service" /etc/systemd/system/gt-ads-openclaw.service
# (Das Python-Gateway und sein Drop-in existieren nicht mehr; hier wird nichts dafuer angelegt.)
# Ein von frueheren Laeufen uebrig gebliebenes Drop-in wird entfernt:
run rm -f /etc/systemd/system/gt-ads-telegram.service.d/10-no-double-polling.conf
run rmdir --ignore-fail-on-non-empty /etc/systemd/system/gt-ads-telegram.service.d 2>/dev/null || true
run systemctl daemon-reload
run systemctl enable --now gt-ads-egress-proxy.service
# Ein zuvor festgefahrener Dienst haelt eine Gateway-Sperre mit frischem Heartbeat (Verfall nach 90 s): erst ruhen lassen.
if [ "$DRY" -eq 0 ] && [ "$(systemctl show gt-ads-openclaw.service -p NRestarts --value 2>/dev/null || echo 0)" -gt 0 ]; then
  echo "OpenClaw war im Neustart-Zyklus: stoppe und warte 95 s, damit die alte Gateway-Sperre ablaeuft ..."
  systemctl stop gt-ads-openclaw.service; sleep 95
fi
run systemctl enable --now gt-ads-openclaw.service
[ "$DRY" -eq 1 ] || [ "${CONFIG_RENDERED:-0}" -eq 0 ] || systemctl restart gt-ads-openclaw.service  # neue Konfiguration sicher uebernehmen

echo
if [ "$DRY" -eq 1 ]; then echo "Fertig (Trockenlauf)."; else
  TG_STATE="aus"; telegram_active && TG_STATE="AN (OpenClaw bedient den Bot)"
  echo "Fertig. OpenClaw-Telegram: $TG_STATE. Das Python-Gateway existiert nicht mehr."
  echo "Naechste Schritte: sudo bash infra/openclaw/deploy/check-tools.sh   (Werkzeugliste des Statusagenten)"
  echo "                   sudo bash infra/openclaw/deploy/verify.sh        (vollstaendige Pruefung)"
fi
