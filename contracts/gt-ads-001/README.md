# GT-ADS-001 – Maschinenlesbarer Vertrag

Status: umgesetzt in U7 · Basis: [API-VERTRAG.md](../../docs/ARBEITSPAKETE/GT-ADS-001/API-VERTRAG.md) v0.1.0 · Stand: 2026-11-12

## Inhalt

| Pfad | Zweck |
|---|---|
| device-registration.openapi.yaml | OpenAPI 3.0.3 aller Endpunkte; verweist für die validierenden Schemas auf schemas/ |
| schemas/*.schema.json | JSON Schema Draft 2020-12 je Request, Response und Fehlerantwort |
| examples/*.json | synthetische Beispiele; je Request mindestens ein gültiges und ein ungültiges Beispiel |

Die Contract-Tests liegen unter apps/api/tests/contract/ (TESTPLAN Abschnitt 4, T3):

- schemas.test.ts prüft Schemas, Beispiele und die OpenAPI-Datei (syntaktisch, Pfade, Referenzen).
- serverResponses.test.ts validiert echte Serverantworten aus Registrierung, Challenge/Token, Heartbeat,
  Admin-API und Fehlerfällen gegen dieselben Schemas.

## Konventionen

- Alle Beispieldaten sind synthetisch (SYN-); es gibt keine echten Geräte-, Personen- oder Zugangsdaten.
- Der eingebettete öffentliche Schlüssel im Registrierungsbeispiel ist ein eigens erzeugter Testschlüssel;
  der private Schlüssel wird nicht gespeichert. Nonce und Signatur im Token-Beispiel wurden mit demselben
  Testschlüssel über die Vertragsnachricht erzeugt (nur als Beispiel, kein Geheimnis).
- Zeitstempel sind ISO-8601 UTC mit Millisekunden und Z; Nonce/Access-Token sind Base64url mit 32 Byte
  (43 Zeichen); IDs sind UUID in Kleinschreibung.
- **Annahme [A]:** Der Registrierungscode wird in der Antwort einmalig angezeigt. Das Schema akzeptiert die
  kanonische 12-Zeichen-Schreibweise ABCDEFGHJKMN und die im Vertragsbeispiel gezeigte gruppierte Form
  ABCD-EFGH-JKMN; der Server liefert derzeit die kanonische Form ohne Trennzeichen. Eine Abweichung von
  dieser Auslegung wäre ein CR, keine stille Änderung.
- Antwort-Schemas erlauben zusätzliche Felder (API-VERTRAG Abschnitt 1: Clients ignorieren Unbekanntes);
  das Fehlerschema ist bewusst streng (additionalProperties: false), damit keine Details nach außen gelangen.

## Nicht enthalten

Keine Änderung des Vertragstextes, keine Android-Tests (U9), keine Produktivdaten.
