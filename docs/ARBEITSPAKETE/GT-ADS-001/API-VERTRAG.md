# GT-ADS-001 – API-Vertrag (Entwurf v0.1.0)

Status: **Entwurf – mit Freigabe von GT-ADS-001 durch den Betreiber gilt v0.1.0 als freigegeben für dieses Paket**; er ist **kein** eingefrorener Vertrag C-01 (`docs/architektur/vertraege/README.md`). WP-002 überführt ihn später nach `contracts/` (dann CR-Pflicht). Bis dahin: Änderungen nur durch den Planer mit Versionserhöhung und Betreiberfreigabe; der Implementierer ändert diese Datei **nicht**.
Stand: 2026-11-09 · Zugehörig: [SPEZIFIKATION.md](SPEZIFIKATION.md), [ARCHITEKTUR.md](ARCHITEKTUR.md)

## 1. Allgemeines
- Basis-Pfad `/v1`. Medientyp `application/json; charset=utf-8` für Requests/Responses (außer 204).
- Zeiten: ISO-8601 UTC mit Millisekunden und `Z` (`2026-01-01T12:00:00.000Z`). IDs: UUID (Kleinbuchstaben). Binärdaten: Base64 (Standard, mit Padding) – außer Nonce/Token: Base64url ohne Padding.
- Header (Gerät): `X-GT-Ads-Api-Version: 1` (Pflicht, sonst 400 `invalid_request`). `X-Request-Id` optional (Server erzeugt sonst eine); wird in der Antwort zurückgegeben.
- Unbekannte Request-Felder → 400 `invalid_request`. Antworten dürfen neue Felder erhalten (Clients ignorieren Unbekanntes).
- **Fehlerformat (alle 4xx/5xx):**
```json
{ "error": { "code": "invalid_registration_code", "message": "Der Code ist ungültig oder abgelaufen.", "request_id": "SYN-req-0001" } }
```
- Fehlercodes (HTTP): `invalid_request` (400) · `invalid_registration_code` (400) · `environment_mismatch` (409) · `key_already_registered` (409) · `unauthorized` (401) · `challenge_invalid` (401) · `device_revoked` (403) · `forbidden` (403) · `not_found` (404) · `rate_limited` (429, Header `Retry-After` Sekunden) · `internal_error` (500). **Keine** weiteren Details nach außen (kein Stacktrace, keine Unterscheidung bei Codefehlern).
- Beispiel-Werte in diesem Dokument sind **synthetisch** (`SYN-…`), keine echten Daten.

## 2. Gerät: Registrierung
### `POST /v1/device/register` (ohne Authentifizierung, rate-limitiert)
Request:
```json
{
  "registration_code": "ABCD-EFGH-JKMN",
  "client_request_id": "00000000-0000-4000-8000-000000000001",
  "public_key": "<Base64 SPKI DER, EC P-256>",
  "app_env": "dev",
  "device_info": {
    "manufacturer": "SYN-Hersteller", "model": "SYN-Modell",
    "os_version": "14", "sdk_int": 34,
    "app_version": "0.1.0", "app_flavor": "dev"
  }
}
```
Validierung: `registration_code` 12 Zeichen nach Normalisierung (Großschreibung, Bindestriche/Leerzeichen entfernt, O→0, I/L→1) aus Alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`; `client_request_id` UUIDv4; `public_key` muss ein gültiger SPKI-EC-Schlüssel der Kurve prime256v1 sein; `app_env` ∈ {`dev`,`test`}; Strings `device_info.*` 1–64 Zeichen, `sdk_int` 1–99.
Antwort `201`:
```json
{ "device_id": "00000000-0000-4000-8000-0000000000d1",
  "server_time": "2026-01-01T12:00:00.000Z", "server_env": "dev",
  "config": { "heartbeat_interval_s": 900, "api_version": 1 } }
```
Verhalten:
- Code **atomar** einlösen (siehe ARCHITEKTUR §3). Gerät mit `state=active`, `last_seen_at=server_time`. Audit `device.registered`.
- **Idempotenz:** gleicher Code **und** gleiche `client_request_id` **und** gleicher `public_key` → erneut `201` mit **demselben** `device_id` (auch nach Verbrauch des Codes). Anderer Schlüssel/andere Request-ID → `400 invalid_registration_code`.
- Code unbekannt/abgelaufen/widerrufen/benutzt → **identisch** `400 invalid_registration_code` (gleiche Meldung, ähnliche Antwortzeit).
- `app_env` ≠ Server-Umgebung → `409 environment_mismatch` (**vor** Codeprüfung ohne Code zu verbrauchen).
- Schlüssel schon registriert → `409 key_already_registered`.
- Zu viele Fehlversuche → `429 rate_limited`.

## 3. Gerät: Authentifizierung (Challenge-Response)
### `POST /v1/device/auth/challenge` (ohne Token)
Request `{ "device_id": "<uuid>" }` → `200`
```json
{ "nonce": "<Base64url, 32 Byte>", "expires_at": "2026-01-01T12:01:00.000Z" }
```
Unbekannte/gesperrte `device_id` → `401 unauthorized` bzw. `403 device_revoked` (gesperrtes Gerät **darf** die Sperre erfahren). Nonce einmalig, 60 s **[A]**.

### `POST /v1/device/auth/token` (ohne Token)
Request:
```json
{ "device_id": "<uuid>", "nonce": "<Base64url>", "signature": "<Base64 DER-ECDSA über Nachricht>" }
```
**Zu signierende Nachricht** (UTF-8, Zeilenumbrüche `\n`, **kein** abschließender Umbruch):
```
gt-ads-auth-v1
<device_id>
<nonce>
```
Algorithmus: ECDSA mit P-256 und SHA-256 (`SHA256withECDSA`, Signatur im ASN.1-DER-Format). Antwort `200`:
```json
{ "access_token": "<Base64url, 32 Byte>", "token_type": "Bearer", "expires_at": "2026-01-01T12:15:00.000Z" }
```
Fehler: Nonce unbekannt/abgelaufen/benutzt oder Signatur falsch → `401 challenge_invalid` (ein Fehlercode, keine Unterscheidung); gesperrt → `403 device_revoked`. Aktualisiert `last_seen_at`.

## 4. Gerät: Heartbeat
### `POST /v1/device/heartbeat` — Header `Authorization: Bearer <access_token>`
Request:
```json
{ "seq": 12, "device_time": "2026-01-01T12:00:00.000Z", "app_version": "0.1.0", "os_version": "14" }
```
`seq` ganzzahlig ≥ 0, pro App-Installation monoton (App zählt hoch und speichert); `device_time` ISO-UTC (nur für `clock_offset`); keine weiteren Felder (Datensparsamkeit).
Antwort `200`:
```json
{ "server_time": "2026-01-01T12:00:01.000Z", "device_state": "active", "config": { "heartbeat_interval_s": 900 } }
```
Verhalten: `last_seen_at = server_time`; `last_clock_offset_ms = server_time − device_time`; `seq ≤ last_seq` → 200 ohne Zurücksetzen von `last_seq`. Token ungültig/abgelaufen → `401 unauthorized`; Gerät gesperrt → `403 device_revoked` (Token sofort ungültig). Heartbeat ist idempotent.

## 5. Admin (Dashboard) – Cookie-Sitzung
Sitzung: Cookie `gt_ads_session` (`HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age=GT_ADS_ADMIN_SESSION_TTL_S`; `Secure` nur wenn `GT_ADS_COOKIE_SECURE=true`). Schreibende Requests (`POST`, `DELETE`) verlangen `Content-Type: application/json` und, falls `Origin` gesendet wird, einen Wert gleich dem eigenen Ursprung; sonst `403 forbidden`. Nicht angemeldet → `401 unauthorized`.

| Methode · Pfad | Zweck | Request | Antwort |
|---|---|---|---|
| `POST /v1/admin/login` | Anmelden | `{ "password": "…" }` | `204` + Cookie; falsch → `401 unauthorized` (generisch), Rate-Limit `429` |
| `POST /v1/admin/logout` | Abmelden | – | `204` |
| `POST /v1/admin/registration-codes` | Code erzeugen | `{ "label": "SYN-Testhandy" }` (optional, ≤ 64) | `201` unten |
| `GET /v1/admin/registration-codes` | Codes auflisten (ohne Klartext) | – | `200 { "items":[{id,label,created_at,expires_at,status}] }`, `status` ∈ `pending`,`used`,`expired`,`revoked` |
| `DELETE /v1/admin/registration-codes/{id}` | unbenutzten Code widerrufen | – | `204`; benutzt/unbekannt → `404 not_found` |
| `GET /v1/admin/devices` | Geräteliste | – | `200` unten |
| `GET /v1/admin/devices/{id}` | Detail | – | `200` (ein Item wie Liste + `last_clock_offset_ms`, `registration_code_id`) |
| `POST /v1/admin/devices/{id}/revoke` | Gerät sperren | `{}` | `204`; bereits gesperrt → `204`; unbekannt → `404` |

`POST /v1/admin/registration-codes` → `201`:
```json
{ "id": "00000000-0000-4000-8000-0000000000c1", "code": "ABCD-EFGH-JKMN", "label": "SYN-Testhandy",
  "expires_at": "2026-01-01T12:15:00.000Z" }
```
`code` nur in **dieser** Antwort; nie wieder abrufbar.
`GET /v1/admin/devices` → `200`:
```json
{ "server_time": "2026-01-01T12:00:05.000Z",
  "online_threshold_s": 1800,
  "items": [ {
    "id": "00000000-0000-4000-8000-0000000000d1", "label": "SYN-Testhandy",
    "manufacturer": "SYN-Hersteller", "model": "SYN-Modell", "os_version": "14", "sdk_int": 34,
    "app_version": "0.1.0", "app_flavor": "dev", "state": "active",
    "registered_at": "2026-01-01T12:00:00.000Z", "last_seen_at": "2026-01-01T12:00:01.000Z",
    "connectivity": "reachable" } ] }
```
`connectivity` wird **vom Server** zur Lesezeit berechnet: `reachable` wenn `server_time − last_seen_at ≤ online_threshold_s`, sonst `last_seen`. Grenzfall: **gleich** Schwelle = `reachable`. Sortierung: `last_seen_at` absteigend. Kein Paging in diesem Paket (Nicht-Ziel; Obergrenze 500 Items, sonst Hinweis im Feld `truncated: true`).

## 6. Öffentlich
`GET /health` → `200 { "status": "ok", "env": "dev", "version": "<app-version>" }` (keine weiteren Daten; kein Datenbankinhalt). Nur über `127.0.0.1` erreichbar.

## 7. Sicherheitsregeln des Vertrags
Keine Geheimnisse (Code, Nonce, Signatur, Token, Passwort, öffentlicher Schlüssel) in Logs/Audit/Fehlermeldungen. Alle Vergleiche geheimer Werte zeitkonstant. Gerätezustand wird bei **jedem** Geräte-Request mit Token geprüft. Alle Zeitentscheidungen mit Serverzeit.

## 8. Kompatibilität
`api_version` = 1. Neue optionale Antwortfelder ohne Versionssprung; Entfernen/Umbenennen/Pflichtfelder → neue Hauptversion und Übergangszeit (Geräte im Feld, `architektur/vertraege/README.md` §2.3).

## 9. Maschinenlesbare Fassung (vom Implementierer exakt nach diesem Dokument zu erstellen)
`contracts/gt-ads-001/device-registration.openapi.yaml` (OpenAPI 3.0.3), `contracts/gt-ads-001/schemas/*.schema.json` (JSON Schema Draft 2020-12 je Request/Response/Fehler), `contracts/gt-ads-001/examples/*.json` (**synthetisch**, jeweils ein gültiges und mindestens ein ungültiges Beispiel je Request). Abweichungen vom Text dieser Datei = Fehler im Code oder CR, **nie** stillschweigend.
