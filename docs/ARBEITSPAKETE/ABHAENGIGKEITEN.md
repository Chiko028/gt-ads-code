# Abhängigkeitsübersicht

Stand: 2026-11-09 · Ableitung aus `ARBEITSPAKETE.md`. „A → B" = B darf erst starten, wenn A `Done` ist.

## 1. Graph (Mermaid)
```mermaid
graph TD
  WP001[WP-001 Repo/CI] --> WP002[WP-002 Verträge]
  WP001 --> WP003[WP-003 Datenumgebungen]
  WP001 --> WP101[WP-101 Compose]
  WP003 --> WP101
  WP101 --> WP102[WP-102 Caddy intern]
  WP101 --> WP103[WP-103 Monitoring]
  WP101 --> WP201[WP-201 DB-Schema]
  WP003 --> WP201
  WP201 --> WP104[WP-104 Backup/Restore]
  WP201 --> WP202[WP-202 Auth/MFA]
  WP202 --> WP203[WP-203 Audit]
  WP202 --> WP204[WP-204 Taxi/Geräte API]
  WP203 --> WP204
  WP002 --> WP204
  WP204 --> WP205[WP-205 Enrollment]
  WP002 --> WP205
  WP201 --> WP206[WP-206 Medien-Upload]
  WP202 --> WP206
  WP206 --> WP207[WP-207 Transkodierung]
  WP204 --> WP208[WP-208 Kampagnen/Buchungen]
  WP206 --> WP208
  WP208 --> WP209[WP-209 Manifest]
  WP002 --> WP209
  WP205 --> WP210[WP-210 Signierte Medien]
  WP206 --> WP210
  WP102 --> WP210
  WP205 --> WP211[WP-211 Status/Ereignisse]
  WP002 --> WP211
  WP211 --> WP212[WP-212 Retention/Rollups]
  WP212 --> WP213[WP-213 Tägl. Auswertung]
  WP205 --> WP214[WP-214 Pause-Befehle]
  WP203 --> WP214
  WP203 --> WP215[WP-215 Konfig/GPS-Schalter]
  WP213 --> WP216[WP-216 Alarme]
  WP103 --> WP216
  WP202 --> WP301[WP-301 Dashboard Login]
  WP204 --> WP302[WP-302 Taxi/Geräte UI]
  WP301 --> WP302
  WP209 --> WP303[WP-303 Medien/Kampagnen UI]
  WP301 --> WP303
  WP213 --> WP304[WP-304 Status UI]
  WP301 --> WP304
  WP214 --> WP305[WP-305 Pause/Konfig UI]
  WP215 --> WP305
  WP001 --> WP401[WP-401 App/Kiosk]
  WP401 --> WP402[WP-402 App Enrollment]
  WP205 --> WP402
  WP402 --> WP403[WP-403 Sync/Download]
  WP209 --> WP403
  WP210 --> WP403
  WP403 --> WP404[WP-404 Player/Scheduler]
  WP404 --> WP405[WP-405 Zustandsautomat]
  WP405 --> WP406[WP-406 Ereignispuffer/Status]
  WP211 --> WP406
  WP405 --> WP407[WP-407 Pause/Taster]
  WP214 --> WP407
  WP404 --> WP408[WP-408 Watchdog]
  WP406 --> WP408
  WP405 --> WP409[WP-409 Presence/GPS-IF]
  WP407 --> WP501[WP-501 HW Stufe 1]
  WP501 --> WP502[WP-502 HW Stufe 2]
  WP502 --> G2{{Gate G2}}
  G2 --> WP503[WP-503 Fahrzeug stehend]
  WP503 --> WP504[WP-504 Feldtest]
  WP504 --> G3{{Gate G3}}
  G3 --> WP106[WP-106 Domain/TLS]
```

## 2. Kritischer Pfad bis zum ersten „Spot läuft auf einem Tablet"
WP-001 → WP-003 → WP-101 → WP-201 → WP-202 → WP-203 → WP-204 → WP-205 (+WP-002) → WP-206 → WP-208 → WP-209 → WP-210 → WP-401 → WP-402 → WP-403 → WP-404.
Parallel möglich: WP-103/104/105 (Infra), WP-301ff (Dashboard, nach Backend-Stand), WP-405ff (nach WP-404), WP-501 sobald erstes Testgerät und WP-405/407 vorliegen.

## 3. Entscheidungs-/Lückenabhängigkeiten (müssen vor WP-Freigabe geklärt sein)
| WP | Braucht Entscheidung/Information |
|---|---|
| WP-001 | A-05 (Technologie bestätigen), L-11 (GitHub, CI) |
| WP-005 | E57–E63 (Ausführungsort, Anbieter, Git-Stufe, Werkzeug, Budget, Vertraulichkeit, PC-Voraussetzungen); **blockiert** den Start jedes KI-Implementierungspakets (z. B. GT-ADS-001) |
| WP-002 | E36, L-03, L-07 |
| WP-201 | L-04, L-08 |
| WP-202/301 | L-05, L-07 |
| WP-206/207/404 | L-01 |
| WP-208/209 | L-03, L-04 |
| WP-212/213 | E22, K-03, K-06, L-07 |
| WP-214/405/407 | E36, E37, E40 |
| WP-216/103 | L-06, L-12 |
| WP-401/501 | L-02, E14, A-09 |
| WP-503 | E42, E43 (Gate G2) |
| WP-106/504 | E1, E2, E3 (Gate G3) |

## 4. Regeln
- Abhängigkeiten werden nur vom Planer geändert und im Katalog gespiegelt.
- Ein WP darf nicht gestartet werden, solange eine Abhängigkeit nicht `Done` oder eine Blockade nicht aufgelöst ist.
- Gates (G1–G4) sind Betreiberentscheidungen aus `ROADMAP.md`.
