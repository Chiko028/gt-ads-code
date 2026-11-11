# Entwicklungs- und Reviewprozess

Status: **Vorgeschlagen – wartet auf Freigabe durch den Betreiber** (ADR-0010).

## 1. Rollen
| Rolle | Wer | Aufgabe | Darf nicht |
|---|---|---|---|
| **Betreiber** | Du | Priorisierung, Freigabe von Arbeitspaketen, Verträgen, Merges, Produktivänderungen, Kosten | – |
| **Planer** | Claude (Planungssitzung) | Arbeitspakete spezifizieren, Konflikte/Lücken melden, ADRs entwerfen | implementieren, mergen, Anforderungen erfinden |
| **Implementierer** | DeepSeek (oder Claude ausnahmsweise, dann Review durch andere Sitzung) | Freigegebenes WP auf Feature-Branch umsetzen, Tests schreiben | Verträge ändern, über WP hinaus ändern, mergen |
| **CI** | GitHub Actions / lokal | Lint, Tests, Contract-Tests, Secret-Scan, Dependency-Check | – |
| **Reviewer** | Claude (frische Sitzung) | Unabhängiges Review gegen WP, Anforderungen, Verträge, DoD | den eigenen Plan „durchwinken", ohne Dateien zu lesen |

## 2. Lebenszyklus eines Arbeitspakets
`Entwurf` → `Spezifiziert` (Planer) → **`Freigegeben`** (Betreiber) → `In Arbeit` (Implementierer) → `PR offen` → `CI grün` → `Review bestanden` (Reviewer) → **`Gemergt`** (nur Betreiber) → `Done` (DoD vollständig, STATUS aktualisiert) → ggf. `Verifiziert` (Abnahme am echten System/Gerät durch Betreiber).
Rücksprünge: Review/CI fehlgeschlagen → `In Arbeit`. Konflikt/Frage → `Blockiert` (Frage in STATUS, Betreiber entscheidet).

## 3. Übergabeprozess (Claude plant → DeepSeek implementiert → Tests → Claude reviewt)
1. **Plan (Claude):** Arbeitsauftrag aus Katalog (`ARBEITSPAKETE.md`) → ggf. Detailauftrag `docs/ARBEITSPAKETE/<ID>/` aus Vorlage. Enthält: Ziel, Eingaben/Datenquellen, betroffene Module, Akzeptanzkriterien (mit Anforderungs-IDs), Tests, DoD, Nicht-Ziele, offene Fragen. Betreiber setzt `Freigegeben`.
2. **Implementierung (DeepSeek):** Branch `wp/WP-xxx-kurz` von `main`; Pflichtlektüre laut `AGENTS.md`; Tests zuerst/zugleich; kleine Commits `WP-xxx: …`; PR mit Vorlage. Bei Unklarheit: stoppen, Frage in STATUS.
3. **Automatisierte Prüfung:** CI läuft bei jedem Push: Lint/Format, Unit-/Integrationstests, Contract-Tests gegen `docs/architektur/vertraege/`+`contracts/`, Secret-Scan, Abhängigkeits-Audit, Prüfung „keine Änderung an geschützten Pfaden ohne CR". PR nur mit grüner CI reviewbar.
4. **Review (Claude, frische Sitzung):** Liest WP + Anforderungen + Verträge + Diff + Testausgabe. Prüft anhand `REVIEW-Checkliste` (unten). Ergebnis als Review-Kommentar: `Bestanden` / `Änderungen nötig` (mit Dateistellen) / `Konflikt gemeldet`.
5. **Merge:** nur nach ausdrücklicher Betreiberfreigabe **„Merge freigegeben"**; ausgeführt von Claude (Squash, `--match-head-commit`) nach Review + grüner CI (Protokoll: `GITHUB_ARBEITSWEISE.md` §6). **Kein Auto-Merge, kein Merge ungeprüfter PRs.** Weder DeepSeek noch eine andere KI merged.
6. **Abschluss:** STATUS aktualisieren, Sitzungsprotokoll, Tag `wp-xxx-done` auf Merge-Commit, ggf. ADR.

## 4. Review-Checkliste (Auszug)
- Stimmt jede Verhaltensänderung mit einem Akzeptanzkriterium/Anforderungs-ID überein? Nichts darüber hinaus (Scope creep)?
- Wurden Verträge, Zustandsmodell, Schwellwerte genau wie dokumentiert umgesetzt? Jede Zahl im Code mit Quelle?
- **Erfundene Inhalte?** Namen/IDs/Kennzeichen/Preise/Kunden/Geräte im Code, Tests, Seeds, Doku → ablehnen.
- Tests: prüfen sie echtes Verhalten (keine Tautologien, keine Mocks der getesteten Einheit, Grenz-/Fehlerfälle, Idempotenz, Offline-Fälle)? Wurden Tests entfernt/abgeschwächt?
- Regression: bestehende Tests grün, Baseline vorher/nachher.
- Sicherheit: Secrets, Eingabevalidierung, Berechtigungen, Logging ohne Personendaten, GPS nur über Schalter/Policy.
- Daten: nur synthetische Daten; keine Produktivbezüge; Umgebungs-Guards vorhanden.
- Rückgängig machbar (`git revert`), Migrationen mit Rückweg.
- Dokumentation/STATUS/Sitzungsprotokoll aktuell; Annahmen und offene Fragen im PR benannt.

## 5. Git-Regeln
- Hauptzweig `main` (geschützt): PR-Pflicht, ≥ 1 menschliche Freigabe, grüne CI, keine Force-Pushes, keine direkten Commits, linearer Verlauf; **Squash-Merge ist die einzige Merge-Art** (ein Commit je Arbeitspaket, leichter rückgängig zu machen).
- **Stand 2026-11-09 (Fakt, GitHub-Hinweis):** Rulesets/Branch-Schutz werden in diesem **privaten Repo im aktuellen Tarif nicht durchgesetzt** (erst mit GitHub Team). Die Punkte oben sind daher vorerst **Arbeitsvereinbarung, keine technische Sperre**; siehe §5a. Ob GitHub Team wirtschaftlich sinnvoll ist, wird nach Einrichtung der Entwicklungsstruktur entschieden.
- Branches: `wp/WP-xxx-kurz`; Doku-Änderungen: `docs/<thema>`; Hotfix: `fix/WP-xxx-kurz`.
- Commits: `WP-xxx: Imperativ, kurz`; Co-Autor der KI im Trailer; keine Secrets; große Binärdateien nicht in Git (Medien-Beispieldaten nur synthetisch und klein).
- Rückgängig: `git revert <merge-commit>` je WP; Tags `wp-xxx-done` und Releases `v0.x.y`. Datenbankmigrationen **vorwärts** mit definiertem Rückweg oder Backup-Pflicht vor Produktiv-Einsatz.
- Repository-Einstellungen (Betreiber, Settings → General → Pull Requests; Empfehlung, **vom Betreiber zu bestätigen**): Allow merge commits **aus**, Allow squash merging **an**, Allow rebase merging **aus**, Allow auto-merge **aus**, Automatically delete head branches **an**.
- Geschützte Pfade (Änderung nur mit Betreiber-Freigabe): `docs/architektur/vertraege/**`, `contracts/**`, `docs/entscheidungen/OFFENE_ENTSCHEIDUNGEN.md`, `docs/konzept/ANFORDERUNGEN.md`, `docs/entscheidungen/adr/**`, `.github/**`, `infra/server-setup/**`.

### 5a. Ersatzregel, solange GitHub-Branch-Schutz nicht aktiv ist (Stand 2026-11-09)
Der technische Schutz fehlt; deshalb gelten diese **organisatorischen** Regeln verbindlich:
- Der Deploy-Key der KI auf dem Server hat Schreibrecht. **Keine KI pusht auf `main`** – Ausnahme nur der dokumentierte Erstcommit. Änderungen ausschließlich auf `wp/…`- oder `docs/…`-Branches und per Pull Request.
- Merge nach `main` erfolgt **nur nach ausdrücklicher Betreiberfreigabe „Merge freigegeben"** und wird von Claude über die GitHub CLI ausgeführt (seit 2026-11-09, Betreiberanweisung; Details und Sicherheitsregeln: `docs/prozess/GITHUB_ARBEITSWEISE.md`). Bis die GitHub-Authentifizierung eingerichtet ist, mergt der Betreiber weiterhin selbst über die Oberfläche.
- Sobald GitHub (Plan/Ruleset/öffentliches Repo o. Ä.) den Schutz erlaubt: aktivieren und diesen Abschnitt ersetzen. Bis dahin ist `main` regelmäßig auf unerwartete Commits zu prüfen (`git log origin/main`).
- Zusätzliche lokale Sperre auf dem Server: `pre-push`-Hook verweigert Pushes auf `main` (nicht versioniert, nur Schutz vor Versehen, kein Ersatz für Branch-Schutz).
- **Credentials:** DeepSeek erhält **nicht** den Server-Deploy-Key. Wenn DeepSeek schreiben soll, braucht es einen eigenen, getrennten Zugang (Empfehlung: separates GitHub-Konto mit Fork und Pull Requests, dann kann es nicht auf `main` des Hauptrepos schreiben) – Entscheidung E46/E45.
- Risiko ist in `STATUS.md` geführt; Notfall: Deploy-Key bei GitHub löschen.

## 6. Entscheidungen und Status
- Jede Architektur-/Prozessentscheidung → ADR (`docs/entscheidungen/adr/`). Produkt-/Geschäftsentscheidungen → Entscheidungsprotokoll in `OFFENE_ENTSCHEIDUNGEN.md` (nur Betreiber).
- `docs/fortschritt/STATUS.md` wird bei **jeder** Sitzung und jedem Statuswechsel eines WP aktualisiert.
- Change Requests für Verträge: `docs/architektur/vertraege/CHANGE_REQUESTS.md`.

## 7. Qualitätsleitplanken
Mindestens: Lint/Typprüfung, Unit-Tests je Modul, Integrationstests gegen echte Datenbank in Test-Umgebung (Docker), Contract-Tests, Secret-Scan, Dependency-Audit, Container-Scan (später), Ergebnis im PR. Abdeckung als Orientierung, nicht als Ziel; Verhalten entscheidet.
