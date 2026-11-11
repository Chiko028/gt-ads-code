# WP-005 – Technischer Entwurf

Status: Entwurf zur Freigabe · Stand: 2026-11-09 · Gilt nur bei **E57 = A**. Basis: [SPEZIFIKATION.md](SPEZIFIKATION.md), `docs/prozess/DEEPSEEK_ENTWICKLUNGSUMGEBUNG.md` §3. Alle Platzhalter `<…>` werden bei Umsetzung aus Entscheidungen bzw. gemessenen Werten gefüllt, nicht geraten.

## 1. Überblick
```mermaid
flowchart LR
  subgraph PC[Betreiber-PC - Docker Desktop/WSL2]
    subgraph INT[Netz agent-int - internal: true]
      AG[agent: Dev-Container non-root]
      DB[(db: PostgreSQL nur Testdaten)]
    end
    subgraph EGR[Netz agent-egress]
      PX[proxy: Allowlist, default deny]
    end
    WS[(Workspace-Ordner: nur Repo-Klon)]
  end
  AG --- DB
  AG -->|HTTP(S) nur über Proxy| PX
  PX -->|erlaubte Domains| NET((Internet))
  AG --- WS
  OP[Betreiber/Claude: sauberer Klon + git fetch] -.->|Übergabe, nie git im Workspace| WS
```

## 2. Dateilayout (verbindlich; neue Dateien im Repo, nichts außerhalb)
```
.devcontainer/devcontainer.json            # Compose-basiert, Nutzer agent, keine Features, keine Host-Mounts
.gitattributes                              # LF für *.sh, *.conf, Dockerfile (Windows-Schutz)
infra/devenv/
├── README.md                               # Betreiber-Anleitung (Start/Stopp/Reset/Schlüssel/Übergabe/Notfall)
├── docker-compose.yml                      # Dienste agent, db, proxy; Netze agent-int (internal), agent-egress
├── agent.Dockerfile                        # Basis per Digest, Nutzer uid 10001, Tools gepinnt
├── .env.local.example                      # NUR Platzhalter; echte Datei .env.local (gitignored)
├── proxy/{Dockerfile,squid.conf,allowlist.txt}
├── hooks/{pre-commit,pre-push,install-hooks.sh,protected-paths.txt}
└── sa/{README.md,sa-01-egress.sh … sa-12-handover.md,report-template.md}
.gitignore (Ergänzung)                      # .env.local, workspace/
```

## 3. Dienste und Härtung
| Dienst | Zweck | Netze | Härtung / Limits |
|---|---|---|---|
| `agent` | Werkzeug + Tests (Node 22 LTS, git, Test-Tools) | **nur** `agent-int` | `user: 10001`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `read_only: true`, `tmpfs: /tmp,/home/agent/.cache`, `pids_limit`, `mem_limit`, `cpus` (Startwerte **[A]** 4 CPU/8 GB/512 PIDs, beim Test anpassen), kein `privileged`, kein Host-Netz, kein Socket |
| `db` | PostgreSQL (Tag per Digest) für Integrationstests | nur `agent-int` | kein Port veröffentlicht, flüchtiges Volume, nur synthetische Daten, eigenes Passwort aus `.env.local` (Testwert, kein Produktivbezug) |
| `proxy` | einziger Weg ins Internet | `agent-int` + `agent-egress` | läuft ohne Root, `squid.conf` mit `http_access deny all` als Standard, nur `CONNECT` auf Port 443 zu Allowlist-Domains; Zugriffsprotokoll auf benanntes Volume; Neustart blockiert nicht (fail-closed) |
- **Proxy-Technologie:** Squid (ausgereift, Domain-Allowlist per `dstdomain`) – **[V]**, bei Umsetzung gegen Alternative (z. B. tinyproxy) kurz abwägen; Kriterium: fail-closed, Log, kein TLS-Aufbrechen (kein MITM, damit keine zusätzlichen Zertifikate im Container).
- **DNS:** Der Agent-Container hat keinen DNS-Zugang nach außen; Namensauflösung externer Ziele läuft über den Proxy.
- **Proxy-Variablen:** `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY=db,localhost` im Agent-Container gesetzt; direkte Verbindungen scheitern ohnehin am internen Netz.

## 4. Workspace und Übergabe
- **Workspace** = dedizierter Ordner `<GT_ADS_WORKSPACE_DIR>` (Vorschlag **[A]** `C:\gt-ads-agent\workspace`) auf dem PC, enthält **nur** den Repo-Klon; eingebunden als Bind-Mount nach `/workspace`. Kein anderer Host-Pfad wird eingebunden.
- Klon ohne `origin`-Zugangsdaten (Stufe 0): `git remote` leer oder auf einen nicht erreichbaren Platzhalter; Hooks aus `hooks/` per `install-hooks.sh` **im Container**.
- **Übergabe (Stufe 0):** Betreiber/Claude führt in einem **separaten sauberen Klon** `git fetch <Workspace-Pfad> wp/<ID>-<kurz>` aus, prüft Diff, pusht selbst. **Nie** git im Workspace auf dem Host (Gefahr durch `.git/hooks`, `.git/config`, `core.fsmonitor`, Aliasse). Test SA-12.
- Zeilenenden: `.gitattributes` erzwingt LF für Skripte/Konfig (WSL/Windows-Falle).

## 5. Geheimnisse
- **Einziges Geheimnis des Agenten:** Modellschlüssel (`GT_ADS_DEVENV_MODEL_API_KEY`) und Basis-URL (`GT_ADS_DEVENV_MODEL_BASE_URL`) – aus `.env.local` (neben dem Repo, **nicht** im Workspace, nicht committet), nur als Umgebung des Werkzeugprozesses (`env_file` des `agent`-Dienstes; Werkzeugstart per Wrapper). Schlüssel separat je Projekt, mit hartem Limit, Rotation **[A]** nach jedem Paket bzw. 30 Tage.
- Kein Schlüssel in Image-Layern, `docker history`, Logs, Transkripten (Test SA-04 mit Canary-Wert).
- `gh`-/GitHub-Token und Deploy-Key des Servers sind **nie** Teil dieser Umgebung.

## 6. Hooks (Komfort, nicht Schutzgrenze)
`pre-commit`: Secret-Scan (gepinnter Scanner im Image) + Abbruch bei Änderungen an Pfaden aus `protected-paths.txt` (bis AC-15 entschieden: Liste aus `ENTWICKLUNGSPROZESS.md` §5 + `.devcontainer/**`, `infra/devenv/**`). `pre-push`: Abbruch bei Ziel `main`. Der Agent kann Hooks ändern – Schutz liefern fehlende Credentials, Review und Allowlist.

## 7. Betrieb
Start/Stopp/Reset per `docker compose` (Projektname `gt-ads-agent`); Reset = `down -v` + neu klonen. Updates von Images/Werkzeugen **nur per PR** (Digest-Änderung sichtbar). Proxy-Log: Stichprobe je Paket (S8). Notfall: Schlüssel beim Anbieter widerrufen, `down -v`, Workspace löschen, Proxy-Log sichern.

## 8. Technische Entscheidungen (rückholbar)
| # | Entscheidung | Begründung | Alternative |
|---|---|---|---|
| T1 | Compose-basierter Dev-Container | Mehrdienstig (Agent, DB, Proxy), VS-Code-kompatibel | Einzelcontainer ohne Proxy (zu offen) |
| T2 | `internal`-Netz + Allowlist-Proxy | Exfiltrationsbegrenzung, einfaches Audit | Host-Firewall-Regeln (unter Windows fragil) |
| T3 | Kein TLS-Aufbrechen | Weniger Angriffsfläche und Zertifikatsverwaltung | MITM-Proxy (Inhaltsfilter, aber Schlüsselrisiko) |
| T4 | Bind-Mount nur Workspace | Übergabe einfach, Reset einfach | Named Volume (Übergabe umständlicher) |
| T5 | Squid **[V]** | Allowlist, Log, bewährt | tinyproxy, Envoy |
| T6 | Android-SDK nicht im Container | Größe/Angriffsfläche; E56 offen | eigener Build-Container (Folgepaket) |
