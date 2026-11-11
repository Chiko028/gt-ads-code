# GT-ADS-001 · U0 – Sitzungsprotokoll (Coding-Agent)

Datum: 2026-11-11
Unteraufgabe: U0 – Minimalgeruest
Branch: agent/U0

## Umsetzung

- Wurzel-package.json mit npm-Workspaces apps/api und apps/dashboard sowie den
  Skripten typecheck und test (delegieren an alle Workspaces).
- .env.example mit allen in SPEZIFIKATION §7 genannten Schluesseln, bewusst
  ohne Werte und ohne Geheimnisse.
- apps/api: package.json (exakte Versionen), tsconfig.json (noEmit, strict),
  vitest.config.ts, Dockerfile mit gepinntem Node-Image.
- apps/dashboard: package.json, vite.config.ts (Proxy /v1 auf 127.0.0.1:8080,
  jsdom fuer Tests), tsconfig.json, index.html, App.tsx und main.tsx.
- infra/compose/docker-compose.dev.yml: nur 127.0.0.1:8080:8080 veroeffentlicht,
  db ohne Port, GT_ADS_ENV=dev, gepinnte Images, Ressourcenlimits.
- infra/compose/README.md: Start/Stopp/Reset, Ports, Umgebung, Sicherheit.
- .gitignore um coverage/ und *.tsbuildinfo ergaenzt.
- apps/api/tests/static/u0-scaffold.test.ts: Compose-Check, Secret-Check,
  Workspace-/Versionscheck (7 Tests).
- apps/dashboard/src/tests/app.test.tsx: UI-Geruest zeigt den leeren Zustand
  ohne Demo-Daten (1 Test).

## Tests (echte Ausgabe)

Befehl: with-postgres sh -c "npm run -s typecheck && npm test -s"

    RUN  v5.1.0 /workspace/apps/api
     ✓ tests/static/u0-scaffold.test.ts (7 tests) 54ms
     Test Files  1 passed (1)
          Tests  7 passed (7)

    RUN  v5.1.0 /workspace/apps/dashboard
     ✓ src/tests/app.test.tsx (1 test) 121ms
     Test Files  1 passed (1)
          Tests  1 passed (1)

Ergebnis: Exit-Code 0, Typecheck ohne Ausgabe/Fehler, beide Workspaces mit
ausgefuehrten Tests.

## Offene Punkte / Annahmen

- Die Image-Tags postgres:17.6-bookworm und node:22.23.4-bookworm-slim konnten
  ohne Netz nicht gegen eine Registry geprueft werden; beide sind gepinnt und
  verwenden kein latest.
- Im Container lauscht die API auf 0.0.0.0, weil Docker den Port sonst nicht
  weiterleiten kann. Nach aussen ist ausschliesslich 127.0.0.1:8080 gebunden.
- .env.example enthaelt keine Werte; die Standardwerte stehen in
  SPEZIFIKATION §7 und werden in U2 in der Konfiguration umgesetzt.

## Fragen

Keine neuen Q-Fragen.
