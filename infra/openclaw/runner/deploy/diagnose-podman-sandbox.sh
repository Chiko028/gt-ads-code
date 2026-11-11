#!/usr/bin/env bash
# Diagnose: Startet GENAU den Podman-Aufruf des Runners (Arbeitsstand anlegen) als occoder - einmal ohne, einmal mit allen Einschraenkungen
# der Unit gt-ads-coding-runner, dann jeweils ohne EINE Einschraenkung. So ist eindeutig, welche Einschraenkung Podman blockiert.
#   sudo bash diagnose-podman-sandbox.sh      -> Bericht nach /tmp/podman-diag.txt (lesbar fuer alle, ohne Geheimnisse)
# Aendert nichts an der Unit oder am System; die Testlaeufe sind fluechtige systemd-run-Einheiten.
set -Eeuo pipefail
cd /
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren." >&2; exit 1; }
OUT=/tmp/podman-diag.txt
CUID="$(id -u occoder)"; CGID="$(id -g occoder)"
WS="$(mktemp -d /var/lib/occoder/diag-ws.XXXXXX)"; chown occoder:occoder "$WS"
trap 'rm -rf "$WS"' EXIT
CMD=(podman run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --userns keep-id --user "$CUID:$CGID"
     --pids-limit 256 --memory 1g --tmpfs /tmp:rw,size=64m -v "$WS:/work:rw" -w /work -e HOME=/tmp -e GIT_CONFIG_NOSYSTEM=1 gtads-sandbox:1
     sh -c 'git init -q -b main && echo DIAG_OK')
ENVS=(-E HOME=/var/lib/occoder -E "XDG_RUNTIME_DIR=/run/user/$CUID" -E PATH=/usr/bin:/bin)
PROPS=("NoNewPrivileges=no" "ProtectSystem=strict" "ReadWritePaths=/var/lib/occoder /run/user/$CUID" "ProtectHome=yes" "PrivateTmp=yes"
       "ProtectKernelModules=yes" "ProtectKernelLogs=yes" "ProtectControlGroups=no" "LockPersonality=yes" "RestrictRealtime=yes"
       "CapabilityBoundingSet=CAP_SETUID CAP_SETGID" "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX" "UMask=0077" "IPAddressDeny=any" "IPAddressAllow=localhost"
       "InaccessiblePaths=/srv /root /home /etc/gt-ads/credentials /etc/gt-ads/openclaw-credentials /var/lib/openclaw" "MemoryMax=3G" "TasksMax=1024")
san() { sed -E 's/[A-Za-z0-9_-]{32,}/<x>/g' | grep -v 'level=warning' | tail -4 | sed 's/^/      /'; }
try() {  # $1 = Bezeichnung, Rest = Eigenschaften
  local name="$1"; shift
  local args=(--wait --pipe --collect --quiet -p User=occoder -p Group=occoder -p WorkingDirectory=/var/lib/occoder "${ENVS[@]}")
  for prop in "$@"; do args+=(-p "$prop"); done
  local out; out="$(timeout 120 systemd-run "${args[@]}" "${CMD[@]}" 2>&1 || true)"
  if echo "$out" | grep -q DIAG_OK; then echo "  OK      $name"; else echo "  FEHLER  $name"; echo "$out" | san; fi
}
{
echo "== Diagnose Podman im Runner-Kontext ($(date)) =="
echo "-- A: als occoder ohne Unit-Einschraenkungen (runuser)"
out="$(runuser -u occoder -- env HOME=/var/lib/occoder XDG_RUNTIME_DIR=/run/user/$CUID PATH=/usr/bin:/bin "${CMD[@]}" 2>&1 || true)"
if echo "$out" | grep -q DIAG_OK; then echo "  OK      runuser"; else echo "  FEHLER  runuser"; echo "$out" | san; fi
echo "-- B: mit ALLEN Einschraenkungen der Unit (systemd-run)"
try "alle Einschraenkungen" "${PROPS[@]}"
echo "-- C: alle Einschraenkungen ausser jeweils EINER (welche blockiert?)"
for i in "${!PROPS[@]}"; do
  rest=(); for j in "${!PROPS[@]}"; do [ "$i" = "$j" ] || rest+=("${PROPS[$j]}"); done
  try "ohne ${PROPS[$i]%%=*}" "${rest[@]}"
done
echo "-- D: vorgeschlagene Unit-Einstellungen (ProtectHome=no, AF_NETLINK erlaubt, alles andere unveraendert)"
fixed=()
for p in "${PROPS[@]}"; do
  case "$p" in
    ProtectHome=*) fixed+=("ProtectHome=no") ;;
    RestrictAddressFamilies=*) fixed+=("RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK") ;;
    *) fixed+=("$p") ;;
  esac
done
try "vorgeschlagene Einstellungen" "${fixed[@]}"
} > "$OUT" 2>&1
chmod 644 "$OUT"
echo "Bericht: $OUT"
