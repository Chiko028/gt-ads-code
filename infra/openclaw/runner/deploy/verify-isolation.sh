#!/usr/bin/env bash
# Negative Zugriffstests (Betreiber 2026-11-11): Codex-Planungsbereich ist fuer DeepSeek/Runner/Gateway unzugaenglich; nur freigegebene Pakete sind lesbar.
#   sudo bash verify-isolation.sh
# Aendert nichts (nur lesende Pruefungen; ein Schreibversuch im Freigabebereich als occoder MUSS scheitern). Ausgabe ohne Geheimnisse.
set -uo pipefail
cd /
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren." >&2; exit 1; }
PLAN=/var/lib/gt-ads-plan; REL=/var/lib/gt-ads-release; FAIL=0
ok()   { echo "  OK     $*"; }
bad()  { echo "  FEHLER $*"; FAIL=1; }
deny() { local who="$1" what="$2"; shift 2; if runuser -u "$who" -- "$@" >/dev/null 2>&1; then bad "$who kann: $what"; else ok "$who kann NICHT: $what"; fi; }
allow(){ local who="$1" what="$2"; shift 2; if runuser -u "$who" -- "$@" >/dev/null 2>&1; then ok "$who kann: $what"; else bad "$who kann nicht: $what"; fi; }
prop() { systemctl show "$1" -p "$2" --value 2>/dev/null; }

echo "1 Identitaeten"
id ocplan >/dev/null 2>&1 && ok "ocplan existiert" || bad "ocplan fehlt"
[ "$(getent passwd ocplan | cut -d: -f7)" = "/usr/sbin/nologin" ] && ok "ocplan ohne Login-Shell" || bad "ocplan hat eine Login-Shell"
for u in ocplan occoder; do for g in sudo adm systemd-journal docker; do id -nG $u | tr ' ' '\n' | grep -qx $g && bad "$u in Gruppe $g"; done; done
id -nG occoder | tr ' ' '\n' | grep -qx gtads-plan-ctl && bad "occoder in gtads-plan-ctl (Planer-Sockets)" || ok "occoder nicht in gtads-plan-ctl"
id -nG ocplan | tr ' ' '\n' | grep -qxE 'openclaw|occoder' && bad "ocplan in openclaw/occoder" || ok "ocplan weder in openclaw noch in occoder"
[ "$(prop gt-ads-coding-runner User)" = "occoder" ] && [ "$(prop gt-ads-planner User)" = "ocplan" ] && ok "getrennte Dienstidentitaeten (occoder / ocplan)" || bad "Dienstidentitaeten nicht getrennt"

echo "2 Planungsbereich (Entwuerfe, Codex-Anmeldung des Planers) - nur ocplan"
for u in occoder openclaw; do
  deny $u "Planungsbereich auflisten" ls $PLAN
  deny $u "Planer-Datenbank lesen" test -r $PLAN/planner.sqlite -a -r $PLAN
  deny $u "Codex-Anmeldung des Planers lesen" ls $PLAN/.openclaw
  deny $u "Planer-Zugangsdaten lesen" ls /etc/gt-ads/planner-credentials
done
[ "$(stat -c %a:%U $PLAN)" = "700:ocplan" ] && ok "Planungsbereich 0700 ocplan" || bad "Planungsbereich: $(stat -c %a:%U $PLAN)"
case "$(prop gt-ads-coding-runner InaccessiblePaths)" in *gt-ads-plan*) ok "Runner-Unit: Planungsbereich unsichtbar (InaccessiblePaths)";; *) bad "Runner-Unit sperrt den Planungsbereich nicht";; esac
case "$(prop gt-ads-coding-runner InaccessiblePaths)" in */srv*) ok "Runner-Unit: Repository (/srv, inkl. Git-Objekte/Branches) unsichtbar";; *) bad "Runner-Unit sperrt /srv nicht";; esac
case "$(prop gt-ads-planner InaccessiblePaths)" in *occoder*) ok "Planer-Unit: Runner-Zustand unsichtbar";; *) bad "Planer-Unit sperrt /var/lib/occoder nicht";; esac

echo "3 Freigabebereich - ocplan schreibt, Runner liest nur"
allow occoder "Freigabebereich lesen" ls $REL
deny occoder "im Freigabebereich schreiben" touch $REL/.isolationstest
deny openclaw "im Freigabebereich schreiben" touch $REL/.isolationstest
rm -f $REL/.isolationstest
W=$(find $REL -perm /022 ! -type l 2>/dev/null | grep -v "^$REL\$" | head -3); [ -z "$W" ] && ok "keine gruppen-/weltbeschreibbaren Freigabedateien" || bad "beschreibbar: $W"
W=$(find $REL ! -user ocplan 2>/dev/null | head -3); [ -z "$W" ] && ok "alle Freigabedateien gehoeren ocplan" || bad "fremder Besitzer: $W"

echo "4 Keine gemeinsam beschreibbaren Verzeichnisse"
SHARED=""
for d in $(find /var/lib /run /opt /etc/gt-ads /srv -xdev -maxdepth 3 -type d 2>/dev/null); do
  if runuser -u occoder -- test -w "$d" 2>/dev/null && runuser -u ocplan -- test -w "$d" 2>/dev/null; then SHARED="$SHARED $d"; fi
done
SHARED=$(echo $SHARED | tr ' ' '\n' | grep -v -E '^(/run/lock|/var/tmp|/var/lib/php/sessions|/run/screen)$' | tr '\n' ' ')
# Sticky System-Temp-Verzeichnisse (z. B. /run/cloud-init/tmp, 1777 root) sind fuer Benutzer beschreibbar, in BEIDEN Diensten aber
# schreibgeschuetzt (ProtectSystem=strict + eigenes /tmp). Sie sind daher kein gemeinsamer Kanal der Dienste.
STRICT=0; [ "$(prop gt-ads-coding-runner ProtectSystem)" = "strict" ] && [ "$(prop gt-ads-planner ProtectSystem)" = "strict" ] && STRICT=1
REST=""; for d in $SHARED; do
  if [ "$STRICT" -eq 1 ] && [ "$(stat -c %a:%U "$d")" = "1777:root" ]; then echo "  INFO   $d: System-Temp (1777 root), in beiden Diensten schreibgeschuetzt (ProtectSystem=strict)"; else REST="$REST $d"; fi
done
[ -z "$REST" ] && ok "kein Verzeichnis, in das beide Dienste schreiben koennen" || bad "gemeinsam beschreibbar: $REST"
[ "$(prop gt-ads-coding-runner PrivateTmp)" = "yes" ] && [ "$(prop gt-ads-planner PrivateTmp)" = "yes" ] && ok "beide Dienste mit eigenem /tmp (PrivateTmp)" || bad "PrivateTmp fehlt"

echo "5 Sockets"
for s in /run/gtads-planner/control.sock /run/gtads-planner/approve.sock; do
  [ "$(stat -c %a:%G $s 2>/dev/null)" = "660:gtads-plan-ctl" ] && ok "$s 0660 gtads-plan-ctl" || bad "$s: $(stat -c %a:%G $s 2>/dev/null)"
  deny occoder "$s oeffnen" python3 -I -c "import socket,sys;s=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1])" $s
done
deny ocplan "Runner-Freigabe-Socket oeffnen" python3 -I -c "import socket;s=socket.socket(socket.AF_UNIX);s.connect('/run/gtads-runner/approve.sock')"
R=$(runuser -u occoder -- python3 -I -c "import json,socket;s=socket.socket(socket.AF_UNIX);s.connect('/run/gtads-runner/approve.sock');s.sendall(b'{\"cmd\":\"strong_confirm\",\"subject\":\"job:1\"}\n');print(s.makefile().readline())" 2>&1)
case "$R" in *root*|*"Permission denied"*|*Errno*) ok "root-Bestaetigung als occoder abgelehnt";; *) bad "root-Bestaetigung als occoder: $R";; esac

echo "6 DeepSeek-Sandbox: keine Planungsdaten, keine Codex-/Freigabe-Zugangsdaten"
CFG=/var/lib/occoder/.openclaw/openclaw.json
python3 -I - "$CFG" <<'PY' && ok "Coder-Sandbox: keine Bind-Mounts, keine Geheimnisse in der Container-Umgebung" || bad "Coder-Sandbox-Konfiguration bedenklich"
import re, sys
t = open(sys.argv[1]).read()
coder = t[t.index("coder: {"):]
bad = [w for w in ("binds", "gt-ads-plan", "gt-ads-release", "/srv", "credentials", "API_KEY", "TOKEN") if w.lower() in coder.lower()]
sys.exit(1 if bad else 0)
PY
CUID=$(id -u occoder)
OUT=$(runuser -u occoder -- env HOME=/var/lib/occoder XDG_RUNTIME_DIR=/run/user/$CUID podman run --rm --network none --read-only --cap-drop ALL --userns keep-id \
  -v /var/lib/occoder/workspace:/work:ro gtads-dev:2 sh -c 'echo CONTAINER_LIEF; ls /var/lib/gt-ads-plan /var/lib/gt-ads-release /srv /etc/gt-ads 2>&1; env | grep -i -E "key|token|secret" | cut -d= -f1' 2>&1)
echo "$OUT" | grep -q CONTAINER_LIEF || bad "Testcontainer startete nicht (gtads-dev:2 installiert?): $(echo "$OUT" | tail -2)"
echo "$OUT" | grep -q -E 'planner.sqlite|index.json|taxiwerbung|credentials' && bad "im Container sichtbar: $(echo "$OUT" | head -3)" || ok "im DeepSeek-Container weder Planungs-/Freigabebereich noch Repository noch Zugangsdaten"
echo "$OUT" | grep -q -i -E '^[A-Z_]*(KEY|TOKEN|SECRET)' && bad "Geheimnis-Variablen im Container: $(echo "$OUT" | grep -i -E 'KEY|TOKEN|SECRET' | head -3)" || ok "keine Schluessel-/Token-Variablen im Container"
deny occoder "Codex-Planer-Anmeldung lesen (auth-profiles)" sh -c "cat $PLAN/.openclaw/agents/planner/agent/auth-profiles.json"

echo "7 Git: keine Entwuerfe in Repositories des Runners"
find $PLAN -name .git -o -name '*.git' 2>/dev/null | grep -q . && bad "Git-Repository im Planungsbereich" || ok "kein Git-Repository im Planungsbereich (Entwuerfe nie in Git)"
for repo in /var/lib/occoder/integration/*.git; do
  [ -d "$repo" ] || continue
  REFS=$(git --git-dir="$repo" for-each-ref --format='%(refname)' | grep -v -E '^refs/(heads/integration|tags/unit-)' | head -3)
  [ -z "$REFS" ] && ok "$(basename $repo): nur integration + Einheiten-Tags" || bad "$(basename $repo): unerwartete Refs $REFS"
done

echo "8 Protokolle"
for u in occoder openclaw; do
  J=$(runuser -u $u -- journalctl -u gt-ads-planner -n 5 --no-pager -q 2>/dev/null | grep -v -i -E 'insufficient permissions|not seeing messages|^-- ' || true)
  [ -z "$J" ] && ok "$u sieht das Journal des Planers nicht" || bad "$u sieht Planer-Journal"
done

echo
[ "$FAIL" -eq 0 ] && echo "ERGEBNIS: alle Isolationspruefungen bestanden" || echo "ERGEBNIS: FEHLER gefunden (siehe oben)"
exit $FAIL
