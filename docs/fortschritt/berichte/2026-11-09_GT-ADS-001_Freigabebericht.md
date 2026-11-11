# Freigabebericht GT-ADS-001 – Android-Geräteregistrierung

Stand: 2026-11-09 · Status: **Spezifiziert, endgültige Implementierungsfreigabe steht aus** · Nichts implementiert, nichts auf dem Server verändert, kein Port geöffnet.
Planung: [SPEZIFIKATION](../../ARBEITSPAKETE/GT-ADS-001/SPEZIFIKATION.md) · [ARCHITEKTUR](../../ARBEITSPAKETE/GT-ADS-001/ARCHITEKTUR.md) · [API-VERTRAG](../../ARBEITSPAKETE/GT-ADS-001/API-VERTRAG.md) · [TESTPLAN](../../ARBEITSPAKETE/GT-ADS-001/TESTPLAN.md) · [DEEPSEEK-AUFTRAG](../../ARBEITSPAKETE/GT-ADS-001/DEEPSEEK-AUFTRAG.md)

## 1. Ziel in einem Satz
Ein Android-Smartphone registriert sich mit kurzlebigem Einmalcode und Keystore-Schlüssel bei einem lokalen Testbackend und erscheint im Dashboard mit Status („Erreichbar"/„Zuletzt gesehen") und letztem Kontakt; Sperren ist möglich.

## 2. Entscheidungsstand (Details: `docs/entscheidungen/OFFENE_ENTSCHEIDUNGEN.md`)
| Punkt | Stand | Restpunkt |
|---|---|---|
| E45 Ort/Datenschutz DeepSeek | 🟦 vorläufig | konkreter Ort/Tool und Datenschutzbewertung festlegen |
| E46 GitHub/Zugang | 🟦 vorläufig | **getrennter DeepSeek-Zugang (Fork/eigenes Konto) fehlt noch**; Branch-Schutz nicht durchsetzbar (Arbeitsvereinbarung) |
| E47 Technologie (ADR-0002) | 🟦 vorläufig | ADR formal noch „Vorgeschlagen" |
| E48 Prozess (ADR-0010…0012) | 🟦 vorläufig | ADRs formal noch „Vorgeschlagen" |
| E49 CI (GitHub Actions) | 🟦 vorläufig | Kosten prüfen, Einrichtung erst mit Freigabe/WP-001 |
| E50 Testzugang Variante T | 🟦 vorläufig | Betreiber startet Dev-Stack auf dem VPS (`sudo docker`), nur `127.0.0.1`, gesonderte Freigabe zum Testzeitpunkt |
| E51 Pilot-Admin-Passwort | 🟦 vorläufig | Betreiber erzeugt Passwort und Hash außerhalb des Repos |
| Q-004 ID-Schema/Reihenfolge | 🟦 vorläufig | – |
| **E54** Handymodell/Android/minSdk | 🔴 **offen bis Gerätetest** | blockiert **nur U9 (Android)** |
| **E56** Android-Buildweg | 🔴 **offen bis Gerätetest** | blockiert **nur U9 (Android)** |
| E52/E53/E55 | Vorschlags-Standardwerte (nicht entschieden) | bestätigen oder ändern |

## 3. Verbleibende Blocker vor dem Start
1. **Endgültige Freigabe** von GT-ADS-001 durch den Betreiber (Status „Freigegeben" in `docs/fortschritt/STATUS.md`).
2. **PR-Reihenfolge:** Squash-Merge von PR 1 (`docs/github-einstellungen`), danach Rebase und Merge von PR 2 (`docs/gt-ads-001-planung`). Erst auf dem gemergten `main` ist die Planung verbindlich.
3. **DeepSeek-Zugang** (E46-Restpunkt) und Ort der Ausführung (E45-Restpunkt) konkret eingerichtet/festgelegt.
4. **U9 (Android) zusätzlich:** E54 (Handymodell, Android-Version, minSdk) und E56 (Buildweg).

## 4. Risiken (bleiben bei Freigabe bestehen)
- Kein erzwungener Branch-Schutz: Merge-Disziplin ist organisatorisch (Ersatzregel §5a).
- Testverkehr ohne TLS (Tunnel, nur Debug/localhost); Pilot-Admin ohne MFA; keine Key Attestation; In-Memory-Rate-Limit nur für Einzelinstanz. Alle bewusst und dokumentiert (K-12, K-13), nicht produktionsreif.
- Alle Standardwerte und die Technologiewahl sind Annahmen des Planers (A-05, A-17…A-19).

## 5. Was die Freigabe bedeutet
Nach Freigabe darf DeepSeek U0–U8 und U10 auf dem Branch `wp/GT-ADS-001-geraeteregistrierung` umsetzen; vor U9 hält es an. Review durch eine frische Claude-Sitzung, Merge nur durch den Betreiber, Handytest nach TESTPLAN §6. Keine Produktion, keine Ports, keine echten Daten.
