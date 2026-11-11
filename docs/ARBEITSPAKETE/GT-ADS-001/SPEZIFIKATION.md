# GT-ADS-001 – Android-Geräteregistrierung: Spezifikation

Status: **Spezifiziert – wartet auf Freigabe durch den Betreiber** (nicht „Freigegeben"; nichts begonnen) · Stand: 2026-11-09 · Rolle Autor: Planer (Claude)
Zugehörige Dateien: [ARCHITEKTUR.md](ARCHITEKTUR.md) · [API-VERTRAG.md](API-VERTRAG.md) · [TESTPLAN.md](TESTPLAN.md) · [DEEPSEEK-AUFTRAG.md](DEEPSEEK-AUFTRAG.md)
Kennzeichen: ✅ bestätigt · 🟦 vorläufig · 🔧 Annahme/Test · ⚖️ rechtlich zu prüfen · **[A]** Annahme dieses Pakets (konfigurierbar, Betreiber bestätigt) · **[E]** offene Entscheidung (siehe §10).

## 1. Ziel (Betreiberauftrag)
Ein Android-**Smartphone** registriert sich sicher bei einem GT-Ads-**Testbackend** und wird im Verwaltungsdashboard als Gerät sichtbar. Es ist ein kontrollierter Pilotversuch der KI-Entwicklungsorganisation (`docs/prozess/ENTWICKLUNGSPROZESS.md`): Claude plant, DeepSeek implementiert, Tests prüfen, Claude reviewt.

## 2. Einordnung in das Projekt (Fakten mit Quelle)
| Aussage | Quelle |
|---|---|
| Enrollment per einmaligem Code, danach geräteeigene Identität | `ANFORDERUNGEN.md` F-A03 (MVP) |
| Schlüsselpaar im Android Keystore, widerrufbar | S-01 (MVP) |
| TLS-Pflicht | S-02 (MVP) → **Ausnahme siehe §8/K-12** |
| Geräteverwaltung, Gerätestatus im Dashboard | F-B01, F-D02 (MVP), Teil ohne Taxi/Gruppen |
| Audit-Log für Verwaltungsaktionen | F-B10 (MVP), nur Minimalversion |
| Fehlende Meldung beweist weder Ausschaltung noch Defekt; Statusmeldungen 30–60 min | ✅ `ZUSTANDSMODELL.md` §1/§5, Protokoll v2.0 §5 |
| Keine erfundenen Daten; getrennte Umgebungen | `KI_REGELN.md`, `DATENTRENNUNG.md` |
| Vertrag C-01 (Geräte-API) existiert noch nicht eingefroren | `architektur/vertraege/README.md` |

## 3. Abgrenzung zum Arbeitspaketkatalog (ID-Konflikt, bewusst aufgelöst)
Der Katalog (`KATALOG.md`) zählt Bausteine als `WP-001…`; `WP-001` ist dort das *Repository-Gerüst*. Der Betreiber nennt dieses Paket **GT-ADS-001**. Festlegung (🟦, wartet auf Bestätigung, Q-004): `GT-ADS-nnn` = **Implementierungspaket (vertikaler Durchstich)**, `WP-xxx` = **Katalogbaustein**. GT-ADS-001 liefert *Teile* von: WP-201 (DB: nur `devices`), WP-203 (Audit minimal), WP-204 (Geräteliste ohne Taxi/Gruppen), WP-205 (Enrollment/Auth), WP-211 (nur Heartbeat/Kontakt), WP-301/302 (Login + Geräteliste, minimal), WP-401/402 (App-Gerüst ohne Kiosk, Enrollment) sowie ein **Minimalgerüst** aus WP-001/003/101. Es ersetzt diese Bausteine nicht; Rest bleibt im Katalog offen. Abweichung vom Katalogpfad (WP-001/002/003/101/201/202 vorher) ist **freigabepflichtig** (§10, Q-004).

## 4. Fachlicher Ablauf
1. **Code erzeugen:** Admin erzeugt im Dashboard einen **Registrierungscode** (optionales Label). Der Code wird **einmalig** angezeigt, serverseitig nur als HMAC-Hash gespeichert, ist **kurzlebig** und **einmal verwendbar**.
2. **Registrieren:** Nutzer gibt den Code in der App ein. Die App erzeugt ein **nicht exportierbares Schlüsselpaar** (Android Keystore, EC P-256) und sendet Code + öffentlichen Schlüssel + Geräteinfos.
3. **Gerät anlegen:** Server prüft Code (gültig, ungenutzt, nicht abgelaufen, Umgebung passt), legt das Gerät an (Status `active`), markiert den Code atomar als benutzt, schreibt Audit-Eintrag.
4. **Authentifizieren:** Jede weitere Kommunikation: **Challenge-Response** (Gerät signiert Server-Nonce mit privatem Schlüssel) → kurzlebiges Access-Token. Es werden **keine** Passwörter/Shared Secrets auf dem Gerät gespeichert.
5. **Kontakt melden:** App sendet **Heartbeat** (beim Start/Vordergrund, nach Registrierung, periodisch im Hintergrund). Server setzt `last_seen_at` mit **Serverzeit**.
6. **Anzeigen:** Dashboard zeigt Geräte mit Status, letztem Kontakt, Modell, Versionen. Admin kann Geräte **sperren** (Widerruf) und unbenutzte Codes **widerrufen**.
7. **Sperre wirkt:** Nächste Anfrage des Geräts wird mit `device_revoked` abgelehnt; die App zeigt „Gerät gesperrt" und stoppt Heartbeats.

## 5. Funktionale Anforderungen (Akzeptanzkriterien)
| ID | Kriterium | Quelle |
|---|---|---|
| AC-01 | Registrierung mit gültigem Code → Gerät erscheint im Dashboard ≤ 1 Dashboard-Refresh (≤ 30 s **[A]**) | Ziel |
| AC-02 | Code ist **einmalig**: zweite Verwendung → `invalid_registration_code`; bei zwei **gleichzeitigen** Registrierungen mit demselben Code gelingt genau eine | F-A03 |
| AC-03 | Abgelaufener, widerrufener, unbekannter, bereits benutzter Code → **identische** Fehlermeldung (keine Unterscheidung nach außen) | Sicherheit |
| AC-04 | Code-TTL, Länge, Versuchsgrenzen sind konfigurierbar; Standard laut §7 **[A]** | [E] E52 |
| AC-05 | Code erscheint nie im Klartext in Datenbank, Logs, Audit, Fehlermeldungen; Klartext nur einmal in der Antwort der Erzeugung | S-… DoD 7 |
| AC-06 | Privater Schlüssel verlässt das Gerät nicht (Keystore, nicht exportierbar); Server speichert nur öffentlichen Schlüssel | S-01 |
| AC-07 | Gerätezugriff nur mit gültigem Token; Token abgelaufen/ungültig → 401; Signatur falsch/Nonce wiederverwendet/abgelaufen → abgelehnt | S-01 |
| AC-08 | Gesperrtes Gerät: bestehende Tokens sofort ungültig (Prüfung bei jeder Anfrage), Neuanmeldung ohne neuen Code unmöglich | S-01 |
| AC-09 | Heartbeat aktualisiert `last_seen_at` mit **Serverzeit**; Gerätezeit beeinflusst die Statusanzeige nicht | Zustandsmodell |
| AC-10 | Dashboardstatus nach §6 korrekt an den Schwellen; Texte nie „defekt"/„ausgeschaltet" | ✅ Protokoll §5 |
| AC-11 | Ausfall der Verbindung führt in der App zu keinem Absturz und keinem Datenverlust; Wiederverbindung setzt Heartbeat fort | Ziel |
| AC-12 | Dashboard: Login, Geräteliste (leerer Zustand ohne Demo-Daten), Code erzeugen, Gerät sperren (mit Bestätigung), Auto-Refresh | §7 |
| AC-13 | Audit-Einträge für: Code erzeugt/widerrufen/benutzt, Gerät registriert/gesperrt, Admin-Login (Erfolg/Fehlschlag), ohne Geheimnisse | F-B10 |
| AC-14 | Server startet nur mit `GT_ADS_ENV` ∈ {`dev`,`test`}; `prod` oder fehlend → Start verweigert | DATENTRENNUNG §2.1 |
| AC-15 | App-Build `dev` verbindet sich nur mit Server derselben Umgebung (`environment_mismatch`) | DATENTRENNUNG §2.6 |
| AC-16 | Keine Seed-/Demo-Geräte, keine realen Kennungen im Repo; Testdaten nur synthetisch (`SYN-`) | KI_REGELN 5–7 |
| AC-17 | Release-Build der App erlaubt **kein** Klartext-HTTP; Debug-Build nur gegenüber `localhost`/`127.0.0.1` | S-02 / K-12 |
| AC-18 | Migration vorwärts und rückwärts getestet; Datenbankinhalt nur in dev/test | C-09 |
| AC-19 | Alle Tests des Testplans ausgeführt; echte Ausgabe im PR; manueller Handytest vom Betreiber bestätigt | DoD |
| AC-20 | Keine neue öffentliche Portfreigabe; Dienste binden nur `127.0.0.1` | Betreiberregel |

## 6. Online-Status und letzter Kontakt (Definition)
- **`last_seen_at`** = Serverzeitpunkt des letzten **authentifizierten** Kontakts (Registrierung, Token-Erneuerung, Heartbeat). Gerätezeit wird nur als `clock_offset` (Server − Gerät) protokolliert, nie als Wahrheit.
- **Status im Dashboard** (zur Lesezeit berechnet, nicht gespeichert):
  - `ERREICHBAR` wenn `jetzt − last_seen_at ≤ T_online`.
  - `ZULETZT_GESEHEN` sonst; Anzeige „Zuletzt gesehen vor … (Datum/Uhrzeit, Europe/Vienna)". Tooltip: „Fehlender Kontakt bedeutet nicht, dass das Gerät defekt oder ausgeschaltet ist."
  - Registrierungszustand getrennt: `Aktiv` / `Gesperrt`.
- **`T_online`** = konfigurierbar `GT_ADS_ONLINE_THRESHOLD_S`; Vorschlag **[A]** 2 × Heartbeat-Intervall (E53). Heartbeat-Intervall **[A]** 900 s (Android-WorkManager-Mindestintervall 15 min, 🔧 Plattformfakt im Test zu bestätigen); Betreiberentscheidung für Tablets bleibt 30–60 min (✅), hier nur Testwert.
- **Kein dauerhafter Internetzugang vorausgesetzt:** Heartbeat ist ein einzelner, idempotenter „Ich bin da"-Aufruf (kein Puffer). Schlägt er fehl: Retry mit Backoff (WorkManager), App bleibt funktionsfähig, zeigt „Letzter erfolgreicher Kontakt: …". Ereignispuffer ist **Nicht-Ziel** (kommt in WP-406).
- Zeitzone Anzeige `Europe/Vienna` (A-14).

## 7. Konfigurationswerte und Standardwerte (alle **[A]**, per Umgebung änderbar, in `.env.example` dokumentiert)
| Schlüssel | Standard | Zweck |
|---|---|---|
| `GT_ADS_REG_CODE_TTL_S` | 900 | Code-Gültigkeit (15 min) |
| `GT_ADS_REG_CODE_LENGTH` | 12 | Zeichen (Base32 ohne I/L/O/U ⇒ 60 Bit) |
| `GT_ADS_REG_MAX_FAILS_PER_SOURCE` / `_WINDOW_S` | 5 / 900 | Fehlversuchsgrenze je Quelle |
| `GT_ADS_REG_MAX_FAILS_GLOBAL_PER_H` | 30 | globale Sperre des Endpunkts |
| `GT_ADS_CHALLENGE_TTL_S` | 60 | Nonce-Gültigkeit |
| `GT_ADS_ACCESS_TOKEN_TTL_S` | 900 | Token-Gültigkeit |
| `GT_ADS_HEARTBEAT_INTERVAL_S` | 900 | Intervall, an App ausgeliefert |
| `GT_ADS_ONLINE_THRESHOLD_S` | 1800 | `T_online` |
| `GT_ADS_ADMIN_SESSION_TTL_S` | 3600 | Dashboard-Sitzung |
Geheimnisse **nur** per Umgebung/Datei außerhalb des Repos: `GT_ADS_CODE_PEPPER`, `GT_ADS_ADMIN_PASSWORD_HASH`, `GT_ADS_DB_URL`.

## 8. Sicherheitsanforderungen (Kurz; Details in ARCHITEKTUR.md §6)
Hash-Speicherung der Codes (HMAC-SHA-256 mit Pepper), Einmalverwendung per atomarem SQL, gleichförmige Fehlermeldungen, Rate-Limit, Challenge-Response mit ECDSA P-256, Tokens nur als Hash gespeichert und bei jeder Anfrage gegen Gerätezustand geprüft, kein Geheimnis in Logs, Admin-Sitzung per HttpOnly-/SameSite-Strict-Cookie, Ursprungsprüfung bei Schreibzugriffen, Dienste nur auf `127.0.0.1`, Umgebungs-Guard, keine Standort-/Kamera-/Mikrofon-Berechtigungen (nur `INTERNET`). **Bekannte Lücke (K-12):** Testverkehr läuft ohne TLS über einen lokalen Tunnel; Klartext nur Debug/localhost; Produktion erfordert TLS (S-02, WP-106). **Bekannte Lücke (K-13):** Pilot-Admin ohne MFA (F-D01 verlangt MFA); nur Testumgebung. **Nicht enthalten:** Key Attestation (Nachweis, dass der Schlüssel hardwaregestützt ist) → V2 (S-03).

## 9. Nicht-Ziele (ausdrücklich nicht in GT-ADS-001)
Taxis/Fahrzeuge/Gruppen und Zuordnung · MFA, Rollen · Kampagnen, Medien, Manifest, Download · Kiosk/Device Owner, Autostart · Zustandsautomat, Fahrzeugbereitschaft, Pause/Taster · Ereignis-/Statusdaten über Heartbeat hinaus · GPS/Presence · Push · TLS/Domain/öffentlicher Zugang · Produktivbetrieb/Deployment nach `prod` · QR-Scan (nur manuelle Codeeingabe) · Update-Mechanismus der App · Mehrsprachigkeit (nur Deutsch) · Billing.

## 10. Offene Entscheidungen und Abhängigkeiten (Blocker vor Freigabe)
Stand 2026-11-09: **vorläufig übernommen (🟦):** E45, E46, E47, E48, E49, E50, E51, Q-004 (je mit Restpunkten, siehe Entscheidungsprotokoll). **Offen bis zum Gerätetest:** **E54** (Telefon: Modell/Android-Version, minSdk) und **E56** (Android-Build-Weg) – sie blockieren nur die Android-Unteraufgabe U9, nicht Backend/Dashboard (U0–U8, U10). **Weiter Vorschläge mit Standardwerten:** E52 (Code-Parameter), E53 (Online-Schwelle), E55 (Klartext nur Debug). **Es fehlt noch:** die endgültige Implementierungsfreigabe des Betreibers. Details: `docs/entscheidungen/OFFENE_ENTSCHEIDUNGEN.md` §I, Analyse K-11…K-15, L-21…L-24.

## 11. Definition of Done (zusätzlich zu `docs/prozess/DEFINITION_OF_DONE.md`)
1. Alle AC-01…AC-20 erfüllt und im PR einzeln belegt.
2. Alle automatisierten Tests aus `TESTPLAN.md` ausgeführt, grün, echte Ausgabe im PR; nicht ausführbare Tests (z. B. Gerätetests ohne Hardware) als **nicht ausgeführt** gemeldet.
3. Manueller Handytest (`TESTPLAN.md` §6) vom Betreiber durchgeführt und protokolliert.
4. Vertrag `API-VERTRAG.md` v0.1.0 unverändert umgesetzt, oder CR dokumentiert; Beispiele synthetisch.
5. Keine Secrets/echten Kennungen im Repo; Secret-Scan sauber; `.env.example` ohne Werte.
6. Keine Änderung an `docs/architektur/vertraege/**` und `docs/entscheidungen/**` durch den Implementierer.
7. Review durch frische Claude-Sitzung „Bestanden"; Merge nur durch Betreiber; `STATUS.md` + Sitzungsprotokoll aktualisiert.
8. Rückgängig machbar: `git revert` der Squash-Merge-Commits genügt; Migration mit Down-Skript; Dev-Datenbank löschbar (`docker compose down -v`) ohne Produktbezug.

## 12. Rückverfolgbarkeit
`F-A03` ✅ teils (nur Code, kein QR) · `S-01` ✅ · `S-02` ⚠ Ausnahme debug · `F-B01` teils · `F-D01` ⚠ Abweichung · `F-D02` teils · `F-B10` teils · `F-A09` teils (nur Kontakt) · `N-13` n.a.
