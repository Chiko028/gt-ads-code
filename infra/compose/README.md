# Dev-/Test-Stack (GT-ADS-001)

Diese Compose-Datei startet das Testbackend und eine PostgreSQL-17-Datenbank.
Sie ist **nur fuer die lokale Entwicklung und Tests** gedacht. Gestartet wird
sie ausschliesslich durch den Betreiber; der Coding-Agent fuehrt sie nicht aus.

## Voraussetzungen

- Docker mit Compose (Version siehe Serverstatus).
- Eine lokale Datei infra/compose/.env mit den noetigen Werten. Sie ist per
  .gitignore ausgeschlossen und wird **nicht** committet. Vorlage:
  .env.example im Repository-Wurzelverzeichnis.
- Pflicht fuer den Start: GT_ADS_DB_PASSWORD, GT_ADS_CODE_PEPPER und
  GT_ADS_ADMIN_PASSWORD_HASH muessen in infra/compose/.env gesetzt sein; ohne
  Wert bricht Compose mit einer Meldung ab.
- Den Admin-Passwort-Hash erzeugt `npm run -s hash-password -w @gt-ads/api`.
  Der scrypt-Hash enthaelt `$`-Zeichen und muss in .env in einfachen
  Anfuehrungszeichen stehen (zum Beispiel `GT_ADS_ADMIN_PASSWORD_HASH='scrypt$...'`),
  damit Compose ihn nicht als Variablenreferenz interpretiert.

## Start und Stopp

Im Verzeichnis infra/compose:

    docker compose -f docker-compose.dev.yml up -d --build
    docker compose -f docker-compose.dev.yml ps
    docker compose -f docker-compose.dev.yml logs -f api
    docker compose -f docker-compose.dev.yml down

Das API-Image kompiliert die TypeScript-Quellen im Build-Stage nach
apps/api/dist und uebernimmt nur dieses Artefakt samt Node-Abhaengigkeiten in
das Runtime-Image. Der Container startet `node apps/api/dist/index.js`;
fehlende Pflichtgeheimnisse verweigern den Start bereits in config.ts.

Zum vollstaendigen Loeschen der Dev-Daten (nur Dev-/Testdaten, kein
Produktbezug):

    docker compose -f docker-compose.dev.yml down -v

## Netzwerk und Ports

- Die API ist ausschliesslich unter 127.0.0.1:8080 erreichbar
  (127.0.0.1:8080:8080). Es wird kein oeffentlicher Port geoeffnet.
- Die Datenbank db hat **keinen** veroeffentlichten Port und ist nur im
  Compose-Netz erreichbar.
- Im Container lauscht die API auf 0.0.0.0, weil Docker den Port sonst nicht
  weiterleiten kann. Nach aussen wirkt nur die Loopback-Bindung.

## Umgebung

- GT_ADS_ENV=dev ist in der Compose-Datei fest gesetzt. prod ist nicht
  vorgesehen; der Server verweigert den Start ausserhalb von dev/test.
- GT_ADS_CODE_PEPPER und GT_ADS_ADMIN_PASSWORD_HASH werden per Compose-
  Interpolation an den API-Container uebergeben. Die uebrigen Parameter aus
  .env.example werden ebenfalls weitergereicht; fehlen sie, gelten die
  Standardwerte aus apps/api/src/config.ts.
- Images sind auf konkrete Versionen gepinnt (kein latest):
  postgres:17.6-bookworm und node:22.23.4-bookworm-slim im API-Dockerfile.
- Ressourcenlimits (Annahme aus ARCHITEKTUR §8): db 1 GB, api 512 MB.

## Tests

Die automatisierten Tests laufen **nicht** gegen diesen Compose-Stack, sondern
gegen eine separate PostgreSQL-Testdatenbank (gt_ads_test). Fuer die
Integrationstests wird der Befehl mit with-postgres gestartet; Details folgen
mit den spaeteren Unteraufgaben.

## Sicherheit

- Keine Secrets in dieser Datei. Zugangsdaten kommen aus infra/compose/.env.
- Keine Demo-/Seed-Daten. Testdaten sind synthetisch (SYN-...).
- Kein Zugriff auf den Docker-Socket des Hosts aus der Anwendung.
