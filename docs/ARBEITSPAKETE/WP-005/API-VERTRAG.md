# WP-005 – Schnittstellenvereinbarung (statt API-Vertrag)

Status: Entwurf · Stand: 2026-11-09 · WP-005 hat **keine HTTP-API**. Verbindlich sind die folgenden vier Schnittstellen; Änderungen nur durch den Planer mit Betreiberfreigabe (Sicherheitsgrenze). Zugehörig: [SPEZIFIKATION.md](SPEZIFIKATION.md), [ARCHITEKTUR.md](ARCHITEKTUR.md).

## 1. Proxy-Allowlist (`infra/devenv/proxy/allowlist.txt`)
- Format: eine Domain je Zeile, Kommentar mit `#` und **Begründung + Entscheidungsnummer** (z. B. `# Modell-API, E58`). **Keine** Wildcards, **keine** IP-Adressen, **kein** `github.com` solange E59 = 0.
- Inhalt bei Erstlieferung (Platzhalter bis zur Entscheidung): `<MODELL-API-DOMAIN laut E58 und Anbieterdoku>` · `registry.npmjs.org`.
- Erweiterung nur per PR mit ausdrücklicher Betreiberfreigabe; Review prüft jede neue Domain auf Notwendigkeit. Ergebnis jeder Änderung: SA-01 und SA-11 erneut grün.

## 2. Umgebungsvariablen und Dateien (Namen verbindlich)
| Name | Bedeutung | Ort | Im Repo? |
|---|---|---|---|
| `GT_ADS_DEVENV_MODEL_API_KEY` | Modellschlüssel (Limit, separat) | `infra/devenv/.env.local` → Prozessumgebung des Werkzeugs | **nein** (nur `.env.local.example` mit Platzhalter) |
| `GT_ADS_DEVENV_MODEL_BASE_URL` | Basis-URL des Modellendpunkts | `.env.local` | nein |
| `GT_ADS_WORKSPACE_DIR` | Host-Ordner des Repo-Klons | `.env.local` | nein |
| `GT_ADS_DEVENV_DB_PASSWORD` | Testpasswort der Postgres-Sidecar (Wegwerfwert) | `.env.local` | nein |
Der Agent-Container erhält **keine** weiteren Variablen vom Host (keine Weitergabe der Host-Umgebung).

## 3. Übergabeprotokoll (Stufe 0)
1. Agent committet lokal auf Branch `wp/<ID>-<kurz>` im Workspace (Commit-Nachricht `<ID>: …`, Trailer `Co-Authored-By: DeepSeek (KI)`).
2. Betreiber/Claude: separater sauberer Klon des Hauptrepos, dann `git fetch <GT_ADS_WORKSPACE_DIR> wp/<ID>-<kurz>:wp/<ID>-<kurz>`; **kein** Checkout im Workspace, keine Hooks/Config des Workspace verwenden (`git -c core.hooksPath=/dev/null …`).
3. Diff, Tests, Pfadprüfung (geschützte Pfade) im sauberen Klon; erst danach Push des Branches und PR (`GITHUB_ARBEITSWEISE.md`).
4. Bei Auffälligkeiten (geänderte `.git/hooks`, `.git/config`, unerwartete Dateien): Übergabe stoppen, melden.

## 4. Sicherheitsabnahme-Bericht (`infra/devenv/sa/report-template.md`)
Je SA-Test: ID, Datum, Ausführender, Befehl (ohne Geheimnisse), **echte Ausgabe** (gekürzt, ohne Schlüssel), Ergebnis (bestanden/fehlgeschlagen/nicht ausgeführt), Bemerkung. Canary-Werte sind synthetisch (`SYN-CANARY-…`). Berichte enthalten **nie** den echten Modellschlüssel.
