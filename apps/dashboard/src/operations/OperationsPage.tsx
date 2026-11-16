/**
 * CX-062 / R-703: lesende Betriebsseite.
 *
 * Drei kompakte Bereiche zeigen ausschliesslich die vorhandene CX-061-Antwort:
 * Readiness mit Pruefzeit, hoechstens 20 letzte technische Alarmereignisse und
 * den letzten Backup-Nachweis. Die Seite liest nur; sie bietet weder eine
 * Backup-Pruefung noch Alarmquittierung oder Konfigurationsaenderung an.
 *
 * Fehlende Listen, fehlende Nachweise, Ladefehler, partielle
 * Nichtverfuegbarkeit und unvollstaendige Protokollierung bleiben getrennt
 * sichtbar. Eine verspaetete Antwort ersetzt nie eine neuere Anfrage.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { FetchLike } from "../admin/adminApi";
import { isAdminApiError } from "../admin/adminApi";
import { useOptionalAdminSession } from "../admin/AdminShell";
import type {
  OperationsAlarms,
  OperationsBackupProof,
  OperationsClient,
  OperationsLastBackupCheck,
  OperationsOverview,
  OperationsReadiness,
} from "./operationsApi";
import { createOperationsClient } from "./operationsApi";

/** Serverseitige Obergrenze; die Anzeige kappt zusaetzlich. */
export const MAX_ALARM_ITEMS = 20;

const UNEXPECTED_MESSAGE = "Ein unerwarteter Fehler ist aufgetreten.";

export interface OperationsPageProps {
  /** Injizierter lesender Client; ohne Angabe wird der Fetch-Client gebaut. */
  readonly client?: OperationsClient;
  readonly operationsClient?: OperationsClient;
  /** Injizierbares fetch fuer den Standardclient. */
  readonly fetchImpl?: FetchLike;
}

type PageState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly data: OperationsOverview };

function messageFor(error: unknown): string {
  return isAdminApiError(error) ? error.message : UNEXPECTED_MESSAGE;
}

function TimeValue({ value }: { readonly value: string | null }) {
  if (value === null) {
    return <span>unbekannt</span>;
  }
  return <time dateTime={value}>{value}</time>;
}

function readinessLabel(status: OperationsReadiness["status"]): string {
  if (status === "ready") {
    return "Bereit";
  }
  if (status === "not_ready") {
    return "Nicht bereit";
  }
  return "Unbekannt";
}

function backupStatusLabel(status: string | null): string {
  if (status === "succeeded") {
    return "Erfolgreich";
  }
  if (status === "failed") {
    return "Fehlgeschlagen";
  }
  if (status === "incomplete") {
    return "Unvollständig";
  }
  if (status === null || status === "") {
    return "Unbekannt";
  }
  return "Unbekannt (" + status + ")";
}

function checkLabel(value: boolean | null): string {
  if (value === null) {
    return "unbekannt";
  }
  return value ? "bestanden" : "fehlgeschlagen";
}

function alarmActionLabel(action: string): string {
  if (action === "technical_alarm.episode.opened") {
    return "Alarm geöffnet";
  }
  if (action === "technical_alarm.episode.resolved") {
    return "Alarm behoben";
  }
  return action;
}

function unknownFieldsText(fields: readonly string[]): string {
  return "Unvollständig: " + fields.join(", ");
}

function alarmReasonText(reason: string | null): string {
  if (reason === "alarm_log_unavailable") {
    return "Alarmprotokoll nicht verfügbar. Eine partielle Anzeige ist nicht möglich.";
  }
  if (reason === null || reason === "") {
    return "Alarmprotokoll nicht verfügbar.";
  }
  return "Alarmprotokoll nicht verfügbar (" + reason + ").";
}

function backupReasonText(reason: string | null): string {
  if (reason === "no_backup_check") {
    return "Noch kein Backup-Nachweis vorhanden.";
  }
  if (reason === "backup_log_unavailable") {
    return "Backup-Protokoll nicht verfügbar. Der letzte Nachweis ist unbekannt.";
  }
  if (reason === "invalid_backup_check_record") {
    return "Der letzte Backup-Nachweis ist unvollständig protokolliert.";
  }
  if (reason === null || reason === "") {
    return "Kein Backup-Nachweis verfügbar.";
  }
  return "Backup-Nachweis nicht verfügbar (" + reason + ").";
}

function ReadinessBlock({
  readiness,
}: {
  readonly readiness: OperationsReadiness;
}) {
  return (
    <section
      aria-labelledby="ops-readiness-heading"
      data-readiness-status={readiness.status}
    >
      <h3 id="ops-readiness-heading">Readiness</h3>
      <dl>
        <dt>Komponentenstatus</dt>
        <dd>{readinessLabel(readiness.status)}</dd>
        <dt>Geprüft (UTC)</dt>
        <dd>
          <TimeValue value={readiness.checkedAt} />
        </dd>
      </dl>
    </section>
  );
}

function AlarmsBlock({ alarms }: { readonly alarms: OperationsAlarms }) {
  const items = alarms.items.slice(0, MAX_ALARM_ITEMS);
  return (
    <section
      aria-labelledby="ops-alarms-heading"
      data-alarms-available={alarms.available ? "true" : "false"}
    >
      <h3 id="ops-alarms-heading">Letzte technische Alarmereignisse</h3>
      {!alarms.available ? (
        <p role="status">{alarmReasonText(alarms.reason)}</p>
      ) : items.length === 0 ? (
        <p>Noch keine technischen Alarmereignisse vorhanden.</p>
      ) : (
        <>
          {alarms.items.length > MAX_ALARM_ITEMS ? (
            <p>
              Es werden die neuesten {MAX_ALARM_ITEMS} von{" "}
              {alarms.items.length} Ereignissen angezeigt.
            </p>
          ) : null}
          <table>
            <caption>Höchstens 20 letzte technische Alarmereignisse</caption>
            <thead>
              <tr>
                <th scope="col">Zeit (UTC)</th>
                <th scope="col">Ereignis</th>
                <th scope="col">Episode</th>
                <th scope="col">Ressource</th>
                <th scope="col">Fehlercode</th>
                <th scope="col">Behoben (UTC)</th>
                <th scope="col">Protokoll</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <TimeValue value={item.at} />
                  </td>
                  <td>{alarmActionLabel(item.action)}</td>
                  <td>{item.episodeId ?? "unbekannt"}</td>
                  <td>{item.resourceId ?? "unbekannt"}</td>
                  <td>{item.errorCode ?? "unbekannt"}</td>
                  <td>
                    <TimeValue value={item.resolvedAt} />
                  </td>
                  <td>
                    {item.unknownFields.length === 0
                      ? "vollständig"
                      : unknownFieldsText(item.unknownFields)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function BackupProofBlock({ proof }: { readonly proof: OperationsBackupProof }) {
  return (
    <dl>
      <dt>Lauf-ID</dt>
      <dd>{proof.runId ?? "unbekannt"}</dd>
      <dt>Ergebnis</dt>
      <dd data-backup-status={proof.status ?? "unknown"}>
        {backupStatusLabel(proof.status)}
      </dd>
      <dt>Abgeschlossen (UTC)</dt>
      <dd>
        <TimeValue value={proof.finishedAt} />
      </dd>
      <dt>Gestartet (UTC)</dt>
      <dd>
        <TimeValue value={proof.startedAt} />
      </dd>
      <dt>Dauer</dt>
      <dd>
        {proof.durationMs === null ? "unbekannt" : proof.durationMs + " ms"}
      </dd>
      <dt>Fehlercode</dt>
      <dd>{proof.errorCode ?? "keiner"}</dd>
      <dt>Prüfungen</dt>
      <dd>
        Wiederherstellung: {checkLabel(proof.checks.restore)}; Inhalt:{" "}
        {checkLabel(proof.checks.content)}; Fremdschlüssel:{" "}
        {checkLabel(proof.checks.foreignKeys)}; Sequenzen:{" "}
        {checkLabel(proof.checks.sequences)}; Bereinigung:{" "}
        {checkLabel(proof.checks.cleanup)}
      </dd>
      <dt>Protokoll</dt>
      <dd>
        {proof.unknownFields.length === 0
          ? "Vollständig"
          : "Unvollständig protokolliert: " +
            proof.unknownFields.join(", ")}
      </dd>
    </dl>
  );
}

function BackupBlock({
  lastBackupCheck,
}: {
  readonly lastBackupCheck: OperationsLastBackupCheck;
}) {
  return (
    <section
      aria-labelledby="ops-backup-heading"
      data-backup-available={lastBackupCheck.available ? "true" : "false"}
    >
      <h3 id="ops-backup-heading">Letzter Backup-Nachweis</h3>
      {!lastBackupCheck.available ? (
        <p role="status">{backupReasonText(lastBackupCheck.reason)}</p>
      ) : lastBackupCheck.proof === null ? (
        <p>Noch kein Backup-Nachweis vorhanden.</p>
      ) : (
        <BackupProofBlock proof={lastBackupCheck.proof} />
      )}
    </section>
  );
}

export function OperationsPage({
  client,
  operationsClient: operationsClientProp,
  fetchImpl,
}: OperationsPageProps = {}) {
  const session = useOptionalAdminSession();
  const invalidateSession = session?.invalidateSession;
  // Ausserhalb der Shell (eigenstaendige Ansicht) entscheidet der Server
  // ueber die Rechte; innerhalb der Shell wird ein Operator nie bedient.
  const allowed = session === null || session.role === "Admin";

  const [state, setState] = useState<PageState>({ kind: "loading" });
  const mountedRef = useRef(true);
  const seqRef = useRef(0);

  const operationsClient: OperationsClient = useMemo(
    () =>
      client ??
      operationsClientProp ??
      createOperationsClient({
        fetchImpl,
        onUnauthorized: invalidateSession,
      }),
    [client, operationsClientProp, fetchImpl, invalidateSession],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      seqRef.current += 1;
    };
  }, []);

  const load = useCallback(async () => {
    if (!allowed) {
      return;
    }
    const seq = ++seqRef.current;
    setState({ kind: "loading" });
    try {
      const data = await operationsClient.getOperations({
        isCurrent: () => mountedRef.current && seq === seqRef.current,
      });
      if (!mountedRef.current || seq !== seqRef.current) {
        return;
      }
      setState({ kind: "ready", data });
    } catch (error) {
      if (!mountedRef.current || seq !== seqRef.current) {
        return;
      }
      // Ein Fehler ersetzt den vorherigen Inhalt; alte Werte bleiben nie
      // als aktuelle Betriebslage stehen.
      setState({ kind: "error", message: messageFor(error) });
    }
  }, [allowed, operationsClient]);

  useEffect(() => {
    if (!allowed) {
      return;
    }
    void load();
  }, [allowed, load]);

  if (!allowed) {
    return (
      <section aria-labelledby="page-heading" data-page-state="forbidden">
        <h2 id="page-heading">Betrieb</h2>
        <p role="alert">
          Kein Zugriff auf die Betriebsseite. Diese lesende Übersicht ist nur
          für Admins bestimmt; die serverseitige Berechtigung bleibt
          maßgeblich.
        </p>
      </section>
    );
  }

  const data = state.kind === "ready" ? state.data : null;

  return (
    <section
      aria-labelledby="page-heading"
      data-page-state={state.kind}
      aria-busy={state.kind === "loading"}
    >
      <h2 id="page-heading">Betrieb</h2>
      <p>
        Lesende Betriebsübersicht: Readiness, letzte technische Alarmereignisse
        und letzter Backup-Nachweis. Es werden keine Prüfungen gestartet und
        keine Zustände verändert.
      </p>

      <button type="button" onClick={() => void load()}>
        Aktualisieren
      </button>

      {state.kind === "loading" ? (
        <p role="status">Betriebsübersicht wird geladen …</p>
      ) : null}

      {state.kind === "error" ? <p role="alert">{state.message}</p> : null}

      {data !== null ? (
        <>
          <p>
            Stand (UTC): <TimeValue value={data.generatedAt} />
          </p>
          <ReadinessBlock readiness={data.readiness} />
          <AlarmsBlock alarms={data.alarms} />
          <BackupBlock lastBackupCheck={data.lastBackupCheck} />
        </>
      ) : null}
    </section>
  );
}
