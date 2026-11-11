#!/usr/bin/env bash
# Prueft die Gemini-Anbindung (lesend): Schluessel gueltig, Modell vorhanden, nur ueber den Proxy. Mit --call zusaetzlich EINE synthetische Anfrage.
#   sudo bash verify-gemini.sh [--call]
# Ob das Projekt kostenlos laeuft (kein Abrechnungskonto), laesst sich daraus NICHT ablesen.
set -Eeuo pipefail
cd /
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren." >&2; exit 1; }
CALL=0; [ "${1:-}" = "--call" ] && CALL=1
python3 -I - "$CALL" <<'PY'
import http.client, json, sys
call = sys.argv[1] == "1"
cfg = json.load(open("/etc/gt-ads/runner.json"))
model = (cfg.get("gemini") or {}).get("model", "")
key = open("/etc/gt-ads/runner-credentials/gemini_api_key", encoding="utf-8").read().strip()
ok = True
def req(method, path, body=None):
    c = http.client.HTTPSConnection("127.0.0.1", 3128, timeout=60)
    c.set_tunnel("generativelanguage.googleapis.com", 443)
    try:
        c.request(method, path, body=body, headers={"x-goog-api-key": key, "Content-Type": "application/json"})
        r = c.getresponse()
        return r.status, r.read(2_000_000)
    finally:
        c.close()
if not key:
    print("  FEHLER kein Schluessel gespeichert (sudo bash set-gemini-key.sh)"); sys.exit(1)
print("  INFO   konfiguriertes Modell: %s" % (model or "(keins)"))
try:
    status, data = req("GET", "/v1beta/models?pageSize=200")
except Exception as exc:
    print("  FEHLER Verbindung ueber den Proxy fehlgeschlagen (%s). Ist generativelanguage.googleapis.com in der Allowlist? (install-coder.sh)" % exc.__class__.__name__); sys.exit(1)
if status != 200:
    print("  FEHLER Modellliste: HTTP %d (Schluessel ungueltig oder kein Zugriff)" % status); sys.exit(1)
names = [m["name"].split("/", 1)[1] for m in json.loads(data).get("models", []) if "generateContent" in m.get("supportedGenerationMethods", [])]
print("  OK     Schluessel gueltig; %d Modelle mit generateContent" % len(names))
cands = [n for n in names if "flash" in n][:12]
print("  INFO   Flash-Modelle (Auswahl): %s" % ", ".join(cands))
if model in names:
    print("  OK     konfiguriertes Modell vorhanden")
else:
    print("  FEHLER Modell '%s' nicht in der Liste - in runner/config/runner.json (gemini.model) ein vorhandenes eintragen" % model); ok = False
if call and ok:
    body = json.dumps({"contents": [{"role": "user", "parts": [{"text": "Antworte nur mit dem Wort OK."}]}], "generationConfig": {"maxOutputTokens": 16}})
    status, data = req("POST", "/v1beta/models/%s:generateContent" % model, body)
    text = ""
    try:
        text = json.loads(data)["candidates"][0]["content"]["parts"][0]["text"].strip()[:40]
    except Exception:
        pass
    print("  %s synthetische Anfrage: HTTP %d, Antwort=%r" % ("OK    " if status == 200 and text else "FEHLER", status, text))
    ok = ok and status == 200 and bool(text)
print("  HINWEIS Kostenlos nur ohne Abrechnungskonto im Google-Projekt (nicht pruefbar). Gemini erhaelt nur synthetische Beispiele.")
sys.exit(0 if ok else 1)
PY
