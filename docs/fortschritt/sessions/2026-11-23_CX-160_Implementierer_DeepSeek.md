# Sitzungsprotokoll CX-160 (R-903) – Abspielnachweis App

- Datum: 2026-11-23
- Branch: agent/CX-160
- Rolle: Coding-Agent (DeepSeek)
- Arbeitspaket: CX-160 v1 – Jeden gezeigten Spot melden, regelmaessig hochladen, Abgleich beim Oeffnen

## Auftrag (Kurzfassung)

Das Tablet meldet fuer jeden beendeten Spot Kampagne, Video, Wanduhrbeginn und
gezeigte Dauer. Ohne Netz geht nichts verloren: die Meldungen werden lokal
gepuffert und mindestens alle 15 Minuten hochgeladen; ein App-Start loest eine
Uploadsperre. Der Controller meldet jeden Spot genau einmal, volle Spots als
vollstaendig, abgebrochene mit gemessener Dauer. Eine fehlerhafte Senke darf die
Wiedergabe nicht beeinflussen.

## Umsetzung (Fakt)

- Neu: playback/SpotPlaySink.kt
  - SpotPlayRecord (Kampagne, Video, startedAt, playedMs, completed),
    fun interface SpotPlaySink mit NONE.
- PlaybackController.kt
  - Optionaler Konstruktorparameter spotPlays (Standard NONE); beide
    produktiven Konstruktoren nutzen SpotPlayRuntime.sink(context).
  - Beim Slotstart wird die Wanduhr gemerkt; reportFinished meldet genau
    einmal je Spot. Voll bei Player-Ende und bei erreichter Slotdauer, nicht
    voll bei Fenster-/Uhrende, Player-Fehler und stop().
  - Dauer monoton gemessen, nie negativ, auf die Slotdauer begrenzt; Fehler
    der Senke werden geschluckt. stopCurrentPlayback meldet ebenfalls genau
    einmal (Schutzflagge), damit kein Endpfad die Meldung verliert.
- Neu: spotplay/SpotPlayStore.kt
  - SpotPlayDatabase ("spot-plays.db", Tabelle spot_plays in der
    Spaltenstruktur des Ereignispuffers seq/event_id/device_id/payload_bytes).
  - SpotPlayRecorder verwirft Nicht-UUIDs und Dauern <= 0 (sowie > 3600000 ms),
    setzt ended_at = started_at + played_ms (UTC, Millisekunden), erzeugt genau
    das Serverschema (play_id, campaign_id, media_id, started_at, ended_at,
    played_ms, completed) und puffert ohne Verdraengung (Kapazitaet 100000).
- Neu: spotplay/SpotPlayUpload.kt
  - SpotPlayUploadScheduler: einmaliger Lauf + periodische Arbeit alle 15
    Minuten, beide mit Netzwerkbedingung; onAppStarted loest die Sperre und
    stoesst einen Lauf an.
  - SpotPlayUploadWorker nutzt EventUploadCoordinator (Tabelle spot_plays) und
    DeviceEventTransport (BatchRoute.SPOT_PLAYS); ein Batch je Lauf,
    WorkManager-Backoff, Sperre bei Auth-/Dauerfehler.
  - SpotPlayRuntime.sink(context): persistiert best effort; ohne Bindung still.
- DeviceEventTransport.kt
  - Neue BatchRoute EVENTS (bisheriger Vertrag) und SPOT_PLAYS
    (/v1/device/spot-plays, Wurzel plays, ID play_id, Antwort
    accepted_play_ids); zusaetzlicher Konstruktor (baseUrl, auth, route).
- EventUploadCoordinator.kt
  - Optionaler Parameter table (telemetry_events Standard, spot_plays erlaubt,
    andere Werte werden abgelehnt); SharedPreferencesUploadGate mit optionalem
    preferencesName.
- MainActivity.kt
  - onStart: bei vorhandener Bindung SyncScheduler.enqueueOneTime und
    SpotPlayUploadScheduler.onAppStarted, jeweils in try/catch.

## Tests (Fakt)

- Neu: test/playback/SpotPlayReportingTest.kt
  - Player-Ende und Slotdauer melden voll, stop() und Player-Fehler melden
    nicht voll und mit gemessener Dauer, Fensterende ist nicht voll, Dauer wird
    auf die Slotdauer begrenzt, kein doppelter Nachweis, fehlerhafte Senke
    stoert die Wiedergabe nicht.
- Neu: test/spotplay/SpotPlayUploadTest.kt
  - Exaktes Serverschema und ended_at aus Start + Dauer, Verwerfen von
    Nicht-UUIDs/0 ms, Kapazitaet ohne Verdraengung, Koordinator loescht aus
    spot_plays nur bestaetigte IDs, Transport sendet {plays:[...]} an
    /v1/device/spot-plays und uebernimmt nur accepted_play_ids, Zeitplan
    15 Minuten mit Netz und Sperrloesung beim App-Start, Worker loescht nur
    Bestaetigtes.
- Ausgefuehrt: cd apps/android && gradle --offline -q testDebugUnitTest assembleDebug
  -> nicht ausfuehrbar in dieser Sandbox: "/bin/sh: 1: gradle: not found"
  (kein JDK/Gradle im Container; keine Installation erlaubt). Es wurde daher
  kein Testergebnis erzeugt; die Tests sind unveraendert vollstaendig vorhanden
  (keine Skips, keine Abschwaechung).
- Vorhandene Tests und Migrationsliste unveraendert; 0017 ist bereits enthalten.

## Annahmen / Offen

- Annahme: Der Server antwortet auf POST /v1/device/spot-plays mit
  accepted_play_ids (so im Arbeitspaket genannt). Der im Repository vorhandene
  CX-159-Handler antwortet dagegen mit den Zaehlern accepted, inserted und
  duplicate_play_ids, ohne ID-Liste. Der Client wuerde eine solche 200-Antwort
  als nicht bestaetigt behandeln (Retryable) und nichts loeschen. Das ist eine
  Vertragsabweichung ausserhalb der erlaubten Pfade und muss vor einem
  produktiven Einsatz geklaert werden (Server um accepted_play_ids ergaenzen
  oder den Client auf die Zaehler verpflichten).
- Testausfuehrung und assembleDebug konnten in der Sandbox mangels
  Gradle/JDK nicht belegt werden.

## Korrektur 1 (2026-11-23)

- Ursache des Testfehlers: Nach dem regulaeren Slotende startet der Controller
  im Ein-Slot-Manifest denselben Slot erneut. Ein direkt danach folgendes
  stop() meldete diesen neuen Spot mit 0 ms als weiteren (nicht vollen)
  Nachweis; der Test "genau einmal" sah dadurch zwei Meldungen.
- Fix im Code: reportFinished meldet keine Nachweise mit playedMs <= 0. Das
  entspricht dem Puffer, der 0-ms-Nachweise ohnehin verwirft, und verhindert
  Doppelmeldungen beim Abbruch direkt nach dem Slotwechsel.
- Test ergaenzt um die Zusicherung, dass 0 ms nicht gemeldet wird; keine
  vorhandenen Tests geaendert, geloescht oder uebersprungen.

## Korrektur 2 (2026-11-23)

- Der zweite Lauf brach nach compileDebugKotlin ab; es wurden keine neuen
  Testergebnisse erzeugt (Testberichte blieben auf dem Stand des ersten Laufs).
  Ein Kotlin-/Test-Compilefehler war aus den Caches nicht belegbar.
- Bereinigt: die nicht benoetigte setFixedLengthStreamingMode-Ueberschreibung
  im Test-Double entfernt (der Transport-Test war bereits im ersten Lauf gruen).
- Der generierte Build-/Gradle-/Kotlin-Zustand im Arbeitsbereich wurde
  geloescht, damit der naechste Lauf frisch kompiliert und testet. Quellcode
  und Tests bleiben unveraendert vollstaendig vorhanden.
