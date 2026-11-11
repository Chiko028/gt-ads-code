"""Synthetischer Codex-Smoke-Test (ohne Projektdaten): ein kleines Beispiel mit absichtlichem Fehler.
Misst das Kontingent vorher/nachher (echter Verbrauch eines kleinen Reviews) und prueft das Berichtsformat. Laeuft als Benutzer occoder.
Verbraucht einen kleinen Teil des Codex-Kontingents - nur nach Freigabe des Betreibers ausfuehren."""

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from executors import CodexReviewer  # noqa: E402
from quota import QuotaGate  # noqa: E402
from review_core import build_review_prompt, extract_review_json, validate_review  # noqa: E402

SPEC = "Die Funktion add(a, b) in calc.py muss die Summe von a und b zurueckgeben. Akzeptanzkriterium: add(2, 3) == 5."
DIFF = "--- /dev/null\n+++ b/calc.py\n@@\n+def add(a, b):\n+    return a - b\n"
TESTS = "FAILED test_calc.py::test_add - assert -1 == 5"


def main():
    with open(sys.argv[1], encoding="utf-8") as handle:
        config = json.load(handle)
    home = config["home"]
    env = {"PATH": "/usr/bin:/bin", "HOME": home, "XDG_RUNTIME_DIR": config["xdg_runtime_dir"], "OPENCLAW_STATE_DIR": home + "/.openclaw",
           "OPENCLAW_CONFIG_PATH": home + "/.openclaw/openclaw.json", "HTTPS_PROXY": "http://127.0.0.1:3128", "HTTP_PROXY": "http://127.0.0.1:3128",
           "NODE_USE_ENV_PROXY": "1", "NO_PROXY": "127.0.0.1,localhost,::1", "OPENCLAW_DISABLE_BONJOUR": "1", "CI": "1"}
    reviewer = CodexReviewer(config, env)
    rcfg = config.get("reviews") or {}
    with tempfile.TemporaryDirectory() as tmp:
        gate = QuotaGate(os.path.join(tmp, "q.sqlite"), reviewer.fetch_usage, {k: rcfg[k] for k in ("limit_percent", "safety_margin_percent") if k in rcfg})
        before = gate.check()
        print("Vorher: ", json.dumps({k: before.get(k) for k in ("allowed", "measurable", "reason", "five_hour", "week", "plan")}, ensure_ascii=False))
        if not before["allowed"]:
            print("ABGEBROCHEN: Kontingent erlaubt keinen Review (Gate). Es wurde nichts verbraucht.")
            return 2
        raw = reviewer.review(build_review_prompt(SPEC, DIFF, TESTS, 1), 600)
        try:
            summary, findings = validate_review(extract_review_json(raw))
        except Exception as exc:
            print("FEHLER: Berichtsformat ungueltig: %s" % exc)
            print("Rohausgabe (gekuerzt, ohne Gewaehr auf Geheimnisfreiheit nicht gespeichert): %d Zeichen" % len(raw))
            return 1
        hit = [f for f in findings if f["file"] == "calc.py" and f["line"] in (1, 2, 3) and f["severity"] in ("high", "medium")]
        print("Fundstellen: %d, davon passend zum eingebauten Fehler: %d" % (len(findings), len(hit)))
        for f in findings[:5]:
            print("  [%s/%s] %s:%d %s" % (f["severity"], f["category"], f["file"], f["line"], f["title"][:100]))
        after = gate.check()
        gate.record_cost(0, before, after)
        if after.get("measurable"):
            print("Nachher: 5h %.1f %% -> %.1f %% genutzt, Woche %.1f %% -> %.1f %% genutzt (gemessener Verbrauch dieses Reviews)" % (
                before["five_hour"]["used_percent"], after["five_hour"]["used_percent"], before["week"]["used_percent"], after["week"]["used_percent"]))
        else:
            print("Nachher: Kontingent nicht messbar: %s" % after["reason"])
        print("ERGEBNIS: %s" % ("bestanden" if hit else "Review lief, fand den eingebauten Fehler aber NICHT"))
        return 0 if hit else 1


if __name__ == "__main__":
    sys.exit(main())
