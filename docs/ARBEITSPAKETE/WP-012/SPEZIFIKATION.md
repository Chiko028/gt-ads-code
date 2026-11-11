# WP-012 – Gemini als optionaler, beratender Zusatz-Reviewer

Stand: 2026-11-10 · Status: **Umgesetzt (PR), nicht installiert, nicht erprobt** · Betreiberentscheidungen (Chat, 2026-11-10): Anmeldung **per API-Schlüssel**; Datenregel **„nur synthetische Beispiele“** (nie GT-Ads-Code).

## 1. Rolle und Grenzen
Gemini prüft nur, wenn der Codex-Review pausiert ist, **nur Pakete mit `"synthetic": true`** (aktuell nur WP-009) und **nur beratend**: keine Korrekturen, kein Einfluss auf Freigaben, ersetzt den Codex-Review nie (der bleibt „wartend“). Ohne Schlüssel oder Modell ist Gemini „nicht eingerichtet“.

## 2. Warum diese Datenregel (Quellen: [Preise](https://ai.google.dev/gemini-api/docs/pricing), [Datenprotokollierung](https://ai.google.dev/gemini-api/docs/logs-policy), [Nutzungsbedingungen](https://ai.google.dev/gemini-api/terms))
Im kostenlosen Tarif darf Google Eingaben und Antworten zur Produktverbesserung nutzen, und menschliche Prüfer können sie lesen; im bezahlten Tarif nicht. Ein Projekt wechselt in den bezahlten Tarif, sobald ein Abrechnungskonto verknüpft ist. Limits des kostenlosen Tarifs sind laut Google änderbar und je Projekt; sie werden nicht über eine Abfrage gemeldet (nur über 429-Fehler).

## 3. Technisch erzwungen (`runner/gemini_review.py`, `review_core.py`; 19 Tests + Mutationsprüfung)
- Paket-Flag `synthetic` muss exakt `true` sein; es gehört zum **Freigabe-Hash** (Umstellen macht Freigaben ungültig).
- **Secret-Scan** des Prompts (Google-/OpenAI-/GitHub-/Slack-/AWS-Schlüssel, Telegram-Token, Private Keys, `password = "…"`): Treffer → nichts wird gesendet. Prompt-Größe ≤ 60 000 Zeichen.
- **Eigenes Anfragebudget** (persistent): ≤ 10 Anfragen je Tag (nach Pazifik-Zeit), ≥ 15 s Abstand, **gezählt vor dem Senden**. HTTP 429 → Pause bis zur nächsten Rückstellung; 401/403 → dauerhaft deaktiviert; andere Fehler → 1 h Pause. Höchstens ein Gemini-Review je Auftrag.
- Schlüssel nur als systemd-Credential (`/etc/gt-ads/runner-credentials/gemini_api_key`, root 0600), nur im Header `x-goog-api-key`, nie in URL/Log/Bericht; Ablage per `set-gemini-key.sh` (versteckte Eingabe).
- Egress: nur `generativelanguage.googleapis.com` über den Proxy (kein Vertex/Cloud-Google).
- Fundstellen werden wie bei Codex **objektiv geprüft** (Datei vorhanden, Zeile existiert).

## 4. Offen / nicht verifiziert [V]
- **„Kostenlos“ ist nicht beweisbar:** Aus dem Schlüssel lässt sich nicht ablesen, ob am Google-Projekt ein Abrechnungskonto hängt. Der Betreiber muss den Schlüssel in AI Studio für ein Projekt **ohne** Abrechnungskonto erstellen; sonst fallen Kosten an und die Daten unterliegen den Bezahl-Bedingungen.
- Modellname `gemini-flash-latest` ist ein **ungeprüfter Standard**; `verify-gemini.sh` listet die vorhandenen Modelle und meldet, ob das konfigurierte existiert.
- Antwortformat/Verhalten gegenüber der echten API ungetestet (nur Attrappen).
- Echte Limits des kostenlosen Tarifs sind nicht verlässlich abfragbar; das eigene Budget ist bewusst konservativ.
