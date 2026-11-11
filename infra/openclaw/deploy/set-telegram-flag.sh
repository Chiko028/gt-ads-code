#!/usr/bin/env bash
# Setzt channels.telegram.enabled in der OpenClaw-Konfiguration DIREKT in der Datei (nur bei gestopptem OpenClaw, nur root).
#   sudo bash set-telegram-flag.sh true|false
# Grund: Bei laufendem Gateway verlangt die CLI Zugangsdaten und aendert nichts; die Datei ist die Quelle der Wahrheit.
set -Eeuo pipefail
cd /
VALUE="${1:-}"; [ "$VALUE" = "true" ] || [ "$VALUE" = "false" ] || { echo "Verwendung: set-telegram-flag.sh true|false" >&2; exit 2; }
CFG="${OPENCLAW_CFG:-/var/lib/openclaw/.openclaw/openclaw.json}"
[ -n "${OPENCLAW_CFG:-}" ] || [ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren." >&2; exit 1; }  # OPENCLAW_CFG nur fuer Tests
if [ -z "${OPENCLAW_CFG:-}" ] && systemctl is-active --quiet gt-ads-openclaw.service; then
  echo "gt-ads-openclaw laeuft noch - zuerst stoppen." >&2; exit 1
fi
python3 -I - "$CFG" "$VALUE" <<'PY'
import re, shutil, sys
path, value = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
pattern = re.compile(r'(telegram"?\s*:\s*\{[^{}]*?enabled"?\s*:\s*)(true|false)')
if not pattern.search(text):
    sys.exit("Telegram-Block mit 'enabled' nicht gefunden - nichts geaendert")
shutil.copy2(path, path + ".bak")
new = pattern.sub(lambda m: m.group(1) + value, text, count=1)
with open(path, "w", encoding="utf-8") as handle:
    handle.write(new)
check = pattern.search(open(path, encoding="utf-8").read())
sys.exit(0 if check and check.group(2) == value else "Schreibpruefung fehlgeschlagen")
PY
echo "channels.telegram.enabled=$VALUE gesetzt ($CFG)"
