# WP-005 – DeepSeek-Entwicklungsumgebung: Spezifikation

Status: **Spezifiziert – blockiert durch Entscheidungen E57–E63; nicht freigegeben; nichts implementiert, nichts installiert, nichts bestellt.** Stand: 2026-11-09 · Autor: Planer (Claude)
Zugehörig: [ARCHITEKTUR.md](ARCHITEKTUR.md) · [API-VERTRAG.md](API-VERTRAG.md) (hier: Schnittstellenvereinbarung) · [TESTPLAN.md](TESTPLAN.md) · [IMPLEMENTIERUNGSAUFTRAG.md](IMPLEMENTIERUNGSAUFTRAG.md)
Übergeordneter Plan: `docs/prozess/DEEPSEEK_ENTWICKLUNGSUMGEBUNG.md` (Begründungen, Risiken, Optionen). Dieses Paket macht daraus ein umsetzbares Arbeitspaket **für den Fall E57 = A** (Dev-Container auf dem Betreiber-PC). Bei E57 = B/C entsteht ein anderes Paket.
Kennzeichen: ✅ bestätigt · 🟦 vorläufig · 🔧 Annahme/Test · ⚖️ rechtlich zu prüfen · **[A]** Annahme dieses Pakets · **[V]** Plattform-/Anbieterwissen, nicht verifiziert.

## 1. Ziel
Eine **isolierte, wegwerfbare Umgebung auf dem Betreiber-PC**, in der DeepSeek Arbeitspakete umsetzt – ohne Zugriff auf VPS, Produktivdaten, Server-/GitHub-Zugangsdaten, ohne freien Internetzugang und ohne Schreibrecht auf `main`. Voraussetzung dafür, dass GT-ADS-001 (und jedes spätere KI-Implementierungspaket) starten darf (`DEEPSEEK-AUFTRAG` §2, B1/B2).

## 2. Einordnung (Quellen)
ADR-0008 (Agenten isoliert), ADR-0010/0011, `KI_REGELN.md` §4 (15–18), `DATENTRENNUNG.md`, Entscheidungen E45/E46 (🟦), Plan `DEEPSEEK_ENTWICKLUNGSUMGEBUNG.md` §3–§8, `GITHUB_ARBEITSWEISE.md` §8 (Übergabe).

## 3. Nicht-Ziele
Keine Installation oder Änderung auf dem VPS · keine Firewall-/Port-/Benutzeränderung · kein Android-SDK im Container · kein autonomer Dauerbetrieb von Agenten (WP-705) · kein Kauf/keine Kontoerstellung durch Claude · kein Produktivbezug · keine Auswahl des Agenten-Werkzeugs vor dem Probelauf (E60) · Git-Stufe 1/Posteingangs-Repo nur, wenn E59/E67 es ausdrücklich verlangen (eigenes Folgepaket).

## 4. Entscheidungsblatt (Betreiber) – so lässt sich schnell antworten
Antwortformat (eine Zeile genügt): `E57=A; E58=<1|2|3>; E59=0; E60=später; E61=<Betrag/Monat>; E62=<ja|nein|teils>; E63=<ja|nein, Betriebssystem>`.
| # | Frage | Optionen und Folgen | Vorschlag | Wirkung auf dieses Paket |
|---|---|---|---|---|
| E57 | Ort | **A** PC (Dev-Container) · B VPS (`taxiagent`, braucht Firewall-/Rechteänderung mit Freigabe) · C eigener Dev-Server (kostenpflichtig) | A | nur A wird hier spezifiziert |
| E58 | Modellzugang | 1 DeepSeek-API direkt · 2 Drittanbieter (EU-Hosting offener Modelle) · 3 Self-Hosting (GPU) | 1 oder 2 nach Prüfung | bestimmt Allowlist-Domain und Schlüsselverwaltung; 3 ⇒ anderes Paket |
| E59 | Git-Zugang | **0** DeepSeek ohne Git-Zugangsdaten, Übergabe per `git fetch` · 1 Maschinenkonto+Fork · Posteingangs-Repo | 0 | bei 1/Posteingang: Zusatzpaket (Konto, Token, Allowlist `github.com`) |
| E60 | Werkzeug | Kandidaten laut Plan §5 (alle **[V]**) | nach Probelauf | nicht Teil der Lieferung; Hook-Punkt in der Umgebung |
| E61 | Budget | Betrag/Monat, hartes Limit beim Anbieter | Betreiber legt fest | ohne Limit **keine** Einrichtung (AC-12) |
| E62 | ⚖️ Quellcode an Anbieter/Standort | ja · nein · Teilmengen | Betreiber/Fachperson | „nein" ⇒ Option 2/3 oder Stopp |
| E63 | PC-Voraussetzung | Windows? Docker Desktop mit WSL2? | Auskunft | Voraussetzung für S2/S4 |

## 5. Akzeptanzkriterien
| ID | Kriterium | Quelle |
|---|---|---|
| AC-01 | Dateistruktur genau nach `ARCHITEKTUR.md` §2; nichts darüber hinaus | Plan §3 |
| AC-02 | Compose: **keine** veröffentlichten Ports; Netz `agent-int` mit `internal: true`; Agent-Container hängt **nur** an `agent-int` | Schutzziel 3 |
| AC-03 | Agent-Container: Nutzer ≠ root, `cap_drop: ALL`, `no-new-privileges`, `read_only` + `tmpfs`, kein `privileged`, kein `network_mode: host`, **kein** Docker-Socket, kein SSH-Agent/Credential-Helper/Host-Home; CPU-/RAM-/PID-Limits gesetzt | Schutzziel 1/4 |
| AC-04 | Alle Images per **Digest** gepinnt, kein `latest`; Werkzeugversionen gepinnt | Plan §3 |
| AC-05 | Proxy: Standard **verweigern**; Allowlist nur aus Schnittstellenvereinbarung §1; Zugriffsprotokoll aktiv; **fail-closed** (Proxy aus ⇒ kein Zugriff) | Schutzziel 3 |
| AC-06 | Keine Geheimnisse im Repo/Image/Workspace; `.env.local` ignoriert; `.env.local.example` nur Platzhalter; Schlüsselübergabe nur als Prozess-Umgebung des Werkzeugs | Schutzziel 4 |
| AC-07 | Hook-Vorlagen (pre-commit: Secret-Scan + Sperre geschützter Pfade; pre-push: `main` gesperrt) – ausdrücklich **Komfort, keine Schutzgrenze** | Plan §4 |
| AC-08 | Betreiber-README: Start, Stopp, Reset, Schlüsselablage, Übergabe per `git fetch` in sauberen Klon, Notfall/Widerruf | Plan §7 |
| AC-09 | Sicherheitsabnahme SA-01…SA-12 vollständig bestanden, Belege im PR (ohne Geheimnisse) | Plan §8 |
| AC-10 | Komplett-Reset und Neuaufbau ≤ 15 min **[A]**, gemessen | Schutzziel 5 |
| AC-11 | Keine Änderung am VPS (Dateien, Dienste, Firewall, Benutzer) | Nicht-Ziel |
| AC-12 | Modellkonto mit **hartem Ausgabenlimit** nachgewiesen (Betreiber) | E61 |
| AC-13 | Werkzeug-Probelauf (K1–K9) auf **Wegwerf-Repo mit synthetischem Inhalt** dokumentiert; Entscheidung E60 eingetragen | Plan §5 |
| AC-14 | Windows-tauglich: Skripte mit LF-Zeilenenden (`.gitattributes`), keine Pfadannahmen außerhalb des Workspace-Ordners | E63 |
| AC-15 | **Geschützte Pfade:** Betreiber entscheidet, ob `.devcontainer/**` und `infra/devenv/**` in die Liste `ENTWICKLUNGSPROZESS.md` §5 aufgenommen werden (Vorschlag: ja, da Sicherheitsgrenze) | Prozess |

## 6. Abgrenzung zu GT-ADS-001
WP-005 schafft nur die Umgebung. GT-ADS-001 startet erst nach AC-09 (SA bestanden) **und** deiner Freigabe. U9 (Android) bleibt zusätzlich von E54/E56 abhängig.

## 7. Definition of Done (zusätzlich zu `DEFINITION_OF_DONE.md`)
1. AC-01…AC-15 einzeln belegt; SA-Ergebnisse vom Betreiber bestätigt (Belege ohne Schlüssel/Tokens).
2. Statische Prüfungen des TESTPLANS ausgeführt, echte Ausgabe im PR; Betreiber-seitige Tests, die Claude nicht ausführen kann, sind als **nicht ausgeführt (durch Betreiber)** gekennzeichnet bis zur Rückmeldung.
3. Review durch frische Claude-Sitzung (E64) bzw. Betreiber; Merge nur nach „Merge freigegeben".
4. `STATUS.md`, Sitzungsprotokoll, Probelauf-Protokoll aktualisiert; Rollback beschrieben (`down -v`, Schlüssel widerrufen).

## 8. Blocker und Risiken
**Blocker vor Freigabe:** E57–E63 (§4) · ggf. E64/E65 für Review/Status. **Risiken:** siehe Plan §9 (Prompt-Injection, Lieferkette, Exfiltration über erlaubte Ziele, Schlüsselmissbrauch, manipulierte `.git`-Dateien, Datenschutz/Vertraulichkeit). Restrisiko: Der Modellschlüssel liegt im Prozess des Werkzeugs; Budgetlimit und Widerruf begrenzen den Schaden.
