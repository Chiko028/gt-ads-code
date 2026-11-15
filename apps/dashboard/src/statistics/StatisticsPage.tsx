/**
 * CX-050 / R-405: eingebundene Statistikseite.
 *
 * Die Seite zeigt die Antwort der vorhandenen CX-049-Route unveraendert:
 * gemeldete Wiedergaben nach Kampagne/Geraet/Taxi getrennt von
 * Geraeteverfuegbarkeit und Sync-Fehlern. Es gibt keine Aggregation im
 * Browser, keine Charts, keinen Export und keine Stammdatenbeschaffung.
 *
 * Filter werden ausschliesslich gemeinsam ueber "Anwenden" abgeschickt.
 * Zeitfelder sind ausdruecklich UTC; initial sind die letzten sieben
 * abgeschlossenen UTC-Tage gewaehlt. null bedeutet unbekannt, eine
 * bestaetigte Null wird als 0 angezeigt.
 */
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { FetchLike } from "../admin/adminApi";
import { isAdminApiError } from "../admin/adminApi";
import { useAdminSession } from "../admin/AdminShell";
import type {
  DeviceQualityRow,
  PlayRow,
  StatisticsClient,
  StatisticsCompleteness,
  StatisticsRequest,
  StatisticsResponse,
} from "./statisticsApi";
import { createStatisticsClient } from "./statisticsApi";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = 31 * DAY_MS;
const UNEXPECTED_MESSAGE = "Ein unerwarteter Fehler ist aufgetreten.";

export interface StatisticsPageProps {
  /** Injizierter Statistikclient; ohne Angabe wird der Fetch-Client gebaut. */
  readonly client?: StatisticsClient;
  /** Injizierbares fetch fuer den Standardclient. */
  readonly fetchImpl?: FetchLike;
  /** Injizierbare Uhr fuer den initialen Sieben-Tage-Zeitraum. */
  readonly now?: Date;
}

type RangeErrorState = {
  readonly kind: "invalid" | "too_long";
  readonly message: string;
};

type ResultState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly data: StatisticsResponse };

function toInputValue(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

function toIsoUtc(ms: number): string {
  return new Date(ms).toISOString();
}

/** Letzte sieben abgeschlossene UTC-Tage: [heute-7d, heute 00:00 UTC). */
export function initialUtcRange(now: Date): { from: string; to: string } {
  const todayStartMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return {
    from: toInputValue(todayStartMs - 7 * DAY_MS),
    to: toInputValue(todayStartMs),
  };
}

/**
 * Liest ein datetime-local-Feld als UTC. Die Kalenderpruefung erfolgt ueber
 * den Rueckweg, damit z. B. der 30. Februar nicht stillschweigend
 * normalisiert wird.
 */
function parseUtcInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (match === null) {
    return null;
  }
  const ms = Date.parse(value + ":00.000Z");
  if (!Number.isFinite(ms)) {
    return null;
  }
  if (new Date(ms).toISOString().slice(0, 16) !== value) {
    return null;
  }
  return ms;
}

function validateRange(
  fromInput: string,
  toInput: string,
): { readonly from: string; readonly to: string } | RangeErrorState {
  const fromMs = parseUtcInput(fromInput);
  const toMs = parseUtcInput(toInput);
  if (fromMs === null || toMs === null) {
    return {
      kind: "invalid",
      message:
        "Bitte für Beginn und Ende gültige UTC-Zeitpunkte angeben (JJJJ-MM-TTTHH:mm).",
    };
  }
  if (toMs <= fromMs) {
    return {
      kind: "invalid",
      message: "Der Zeitraum ist ungültig: Das Ende muss nach dem Beginn liegen.",
    };
  }
  if (toMs - fromMs > MAX_RANGE_MS) {
    return {
      kind: "too_long",
      message: "Der Zeitraum ist zu lang: höchstens 31 Tage sind zulässig.",
    };
  }
  return { from: toIsoUtc(fromMs), to: toIsoUtc(toMs) };
}

function optionalId(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function formatPercent(ratio: number | null): string {
  if (ratio === null) {
    return "unbekannt";
  }
  const percent = Math.round(ratio * 1000) / 10;
  return String(percent).replace(".", ",") + " %";
}

function formatDuration(ms: number | null): string {
  return ms === null ? "unbekannt" : String(ms) + " ms";
}

function qualityScopeLabel(scope: string): string {
  return scope === "device_taxi_time"
    ? "Gerät und Taxi im gewählten Zeitraum (device_taxi_time)"
    : scope;
}

function missingDayReason(reason: string): string {
  if (reason === "no_raw_evidence") {
    return "keine Rohdaten vorhanden";
  }
  if (reason === "raw_retention_gap") {
    return "Lücke in der Rohdatenaufbewahrung";
  }
  return reason;
}

function messageFor(error: unknown): string {
  return isAdminApiError(error) ? error.message : UNEXPECTED_MESSAGE;
}

function PlayTable({ plays }: { readonly plays: readonly PlayRow[] }) {
  if (plays.length === 0) {
    return <p>Keine Wiedergaben im gewählten Zeitraum.</p>;
  }
  return (
    <table>
      <caption>Gemeldete Wiedergaben – keine Sichtkontakte</caption>
      <thead>
        <tr>
          <th scope="col">Kampagne</th>
          <th scope="col">Gerät</th>
          <th scope="col">Taxi</th>
          <th scope="col">Wiedergaben</th>
          <th scope="col">Erste Wiedergabe (UTC)</th>
          <th scope="col">Letzte Wiedergabe (UTC)</th>
        </tr>
      </thead>
      <tbody>
        {plays.map((play, index) => (
          <tr
            key={
              play.campaignId === null
                ? "ohne-kampagne-" + play.deviceId + "-" + index
                : play.campaignId + "-" + play.deviceId + "-" + index
            }
          >
            <td>{play.campaignId ?? "ohne Kampagne"}</td>
            <td>{play.deviceId}</td>
            <td>{play.taxiId ?? "unbekannt"}</td>
            <td>{play.playCount}</td>
            <td>{play.firstPlayedAt}</td>
            <td>{play.lastPlayedAt}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function QualityTable({
  rows,
}: {
  readonly rows: readonly DeviceQualityRow[];
}) {
  if (rows.length === 0) {
    return <p>Keine Gerätequalitätswerte im gewählten Zeitraum.</p>;
  }
  return (
    <table>
      <caption>
        Gerätequalität und Sync-Fehler – getrennt von den Wiedergaben
      </caption>
      <thead>
        <tr>
          <th scope="col">Gerät</th>
          <th scope="col">Taxi</th>
          <th scope="col">Verfügbarkeit</th>
          <th scope="col">Beobachtet</th>
          <th scope="col">Technische Störung</th>
          <th scope="col">Sync-Fehler</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.deviceId}>
            <td>{row.deviceId}</td>
            <td>{row.taxiId ?? "unbekannt"}</td>
            <td>
              {row.availabilityRatio === null ? (
                <>
                  <span>unbekannt</span>
                  {row.availabilityReason === null ? null : (
                    <span> – {row.availabilityReason}</span>
                  )}
                </>
              ) : (
                formatPercent(row.availabilityRatio)
              )}
            </td>
            <td>{formatDuration(row.observedMs)}</td>
            <td>{formatDuration(row.technicalFaultMs)}</td>
            <td>{row.syncErrors}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CompletenessBlock({
  completeness,
  qualityScope,
}: {
  readonly completeness: StatisticsCompleteness;
  readonly qualityScope: string;
}) {
  return (
    <section
      aria-labelledby="stats-completeness-heading"
      data-completeness={completeness.status}
    >
      <h3 id="stats-completeness-heading">Vollständigkeit</h3>
      <p>
        Status:{" "}
        {completeness.status === "complete" ? "Vollständig" : "Unvollständig"}
      </p>
      <p>Datenstand (UTC): {completeness.dataAsOf}</p>
      <p>Geltungsbereich der Qualitätswerte: {qualityScopeLabel(qualityScope)}</p>
      {completeness.status === "incomplete" ? (
        <div role="note">
          <p>
            Die Auswertung ist unvollständig. Zahlen sind keine vollständige
            Darstellung des Zeitraums.
          </p>
          {completeness.reasons.length === 0 ? null : (
            <ul>
              {completeness.reasons.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          )}
          {completeness.missingDays.length === 0 ? null : (
            <ul>
              {completeness.missingDays.map((day) => (
                <li key={day.day + "-" + day.reason}>
                  {day.day}: {missingDayReason(day.reason)}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p>Keine Datenlücken gemeldet.</p>
      )}
    </section>
  );
}

function DefinitionBlock({ data }: { readonly data: StatisticsResponse }) {
  const definition = data.definition;
  return (
    <section aria-labelledby="stats-definition-heading">
      <h3 id="stats-definition-heading">Messdefinition</h3>
      <dl>
        <dt>Intervall</dt>
        <dd>{definition.interval}</dd>
        <dt>Wiedergaben</dt>
        <dd>{definition.playCount}</dd>
        <dt>Kampagnenzuordnung</dt>
        <dd>{definition.campaignAttribution}</dd>
        <dt>Taxizuordnung</dt>
        <dd>{definition.taxiAttribution}</dd>
        <dt>Verfügbarkeit</dt>
        <dd>{definition.availability}</dd>
        <dt>Sync-Fehler</dt>
        <dd>{definition.syncErrors}</dd>
        <dt>Ausgeschlossen</dt>
        <dd>
          {definition.excludes.length === 0 ? (
            "nichts"
          ) : (
            <ul>
              {definition.excludes.map((entry, index) => (
                <li key={index}>{entry}</li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
    </section>
  );
}

export function StatisticsPage({
  client,
  fetchImpl,
  now,
}: StatisticsPageProps = {}) {
  const { invalidateSession } = useAdminSession();
  const [initial] = useState(() => initialUtcRange(now ?? new Date()));

  const [campaignId, setCampaignId] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [taxiId, setTaxiId] = useState("");
  const [fromInput, setFromInput] = useState(initial.from);
  const [toInput, setToInput] = useState(initial.to);
  const [rangeError, setRangeError] = useState<RangeErrorState | null>(null);
  const [result, setResult] = useState<ResultState>({ kind: "idle" });

  const mountedRef = useRef(true);
  const seqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      seqRef.current += 1;
    };
  }, []);

  const statisticsClient: StatisticsClient = useMemo(
    () =>
      client ?? createStatisticsClient({ fetchImpl, onUnauthorized: invalidateSession }),
    [client, fetchImpl, invalidateSession],
  );

  const apply = useCallback(async () => {
    const validated = validateRange(fromInput, toInput);
    if ("kind" in validated) {
      setRangeError(validated);
      return;
    }
    setRangeError(null);
    const request: StatisticsRequest = {
      from: validated.from,
      to: validated.to,
      campaignId: optionalId(campaignId),
      deviceId: optionalId(deviceId),
      taxiId: optionalId(taxiId),
    };
    const seq = ++seqRef.current;
    setResult({ kind: "loading" });
    try {
      const data = await statisticsClient.getStatistics(request);
      if (!mountedRef.current || seq !== seqRef.current) {
        return;
      }
      setResult({ kind: "ready", data });
    } catch (error) {
      if (!mountedRef.current || seq !== seqRef.current) {
        return;
      }
      // Ein Fehler darf keine alten Zahlen als aktuelle Auswertung stehen
      // lassen; der Zustand ersetzt deshalb das vorherige Ergebnis.
      setResult({ kind: "error", message: messageFor(error) });
    }
  }, [
    campaignId,
    deviceId,
    fromInput,
    statisticsClient,
    taxiId,
    toInput,
  ]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void apply();
  }

  const isEmpty =
    result.kind === "ready" &&
    result.data.plays.length === 0 &&
    result.data.deviceQuality.length === 0;

  const pageState =
    result.kind === "ready" ? (isEmpty ? "empty" : "ready") : result.kind;

  return (
    <section aria-labelledby="page-heading" data-page-state={pageState}>
      <h2 id="page-heading">Statistik</h2>
      <p>
        Gemeldete Wiedergaben und Gerätequalität werden getrennt ausgewiesen.
        Wiedergaben sind keine Sichtkontakte.
      </p>

      <form onSubmit={handleSubmit} aria-label="Statistikfilter" noValidate>
        <p>
          <label htmlFor="stats-campaign">Kampagnen-ID (optional)</label>
          <input
            id="stats-campaign"
            name="campaign_id"
            type="text"
            value={campaignId}
            onChange={(event) => setCampaignId(event.target.value)}
          />
        </p>
        <p>
          <label htmlFor="stats-device">Geräte-ID (optional)</label>
          <input
            id="stats-device"
            name="device_id"
            type="text"
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
          />
        </p>
        <p>
          <label htmlFor="stats-taxi">Taxi-ID (optional)</label>
          <input
            id="stats-taxi"
            name="taxi_id"
            type="text"
            value={taxiId}
            onChange={(event) => setTaxiId(event.target.value)}
          />
        </p>
        <p>
          <label htmlFor="stats-from">Von (UTC)</label>
          <input
            id="stats-from"
            name="from"
            type="datetime-local"
            value={fromInput}
            onChange={(event) => setFromInput(event.target.value)}
          />
        </p>
        <p>
          <label htmlFor="stats-to">Bis (UTC)</label>
          <input
            id="stats-to"
            name="to"
            type="datetime-local"
            value={toInput}
            onChange={(event) => setToInput(event.target.value)}
          />
        </p>
        <p>
          Zeitangaben werden als UTC interpretiert. Der Zeitraum ist
          verpflichtend und darf höchstens 31 Tage umfassen.
        </p>
        <button type="submit">Anwenden</button>
      </form>

      {rangeError === null ? null : (
        <p role="alert" data-range-state={rangeError.kind}>
          {rangeError.message}
        </p>
      )}

      {result.kind === "idle" ? (
        <p>Noch keine Auswertung. Filter wählen und „Anwenden“ drücken.</p>
      ) : null}

      {result.kind === "loading" ? (
        <p role="status">Statistik wird geladen …</p>
      ) : null}

      {result.kind === "error" ? (
        <p role="alert" data-page-state="error">
          {result.message}
        </p>
      ) : null}

      {result.kind === "ready" ? (
        <div>
          <p>
            Ausgewerteter Zeitraum: {result.data.from} bis {result.data.to}{" "}
            (UTC)
          </p>
          <CompletenessBlock
            completeness={result.data.completeness}
            qualityScope={result.data.qualityScope}
          />
          <DefinitionBlock data={result.data} />

          {isEmpty ? (
            <p data-page-state="empty">
              Keine Statistikdaten im gewählten Zeitraum.
            </p>
          ) : null}

          <section aria-labelledby="stats-plays-heading">
            <h3 id="stats-plays-heading">Gemeldete Wiedergaben</h3>
            <p>
              Wiedergaben nach Kampagne, Gerät und Taxi – keine Sichtkontakte.
            </p>
            <PlayTable plays={result.data.plays} />
          </section>

          <section aria-labelledby="stats-quality-heading">
            <h3 id="stats-quality-heading">Gerätequalität und Sync-Fehler</h3>
            <p>
              Getrennt von den Wiedergaben. Geltungsbereich:{" "}
              {qualityScopeLabel(result.data.qualityScope)}.
            </p>
            <QualityTable rows={result.data.deviceQuality} />
          </section>
        </div>
      ) : null}
    </section>
  );
}

