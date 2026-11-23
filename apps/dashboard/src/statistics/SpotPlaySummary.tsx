/**
 * CX-161: Monatsuebersicht der Abspielnachweise auf der Statistikseite.
 *
 * Die Uebersicht ist die verstaendliche Leseflaeche: Monatswahl, Kennzahlen,
 * Minuten je Taxi, Bildschirmzeit je Werbevideo und ein CSV-Kundenbericht.
 * Sie aggregiert nichts neu, sondern stellt die Serverwerte dar. Die
 * bisherigen technischen Angaben bleiben darunter eingeklappt erreichbar.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";

import { isAdminApiError } from "../admin/adminApi";
import type {
  SpotPlaySummary as SpotPlaySummaryData,
  SpotPlaySummaryClient,
} from "./spotPlaysApi";

const UNEXPECTED_MESSAGE = "Ein unerwarteter Fehler ist aufgetreten.";
const MONTH_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

const monthFormatter = new Intl.DateTimeFormat("de-DE", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const minuteFormatterUnderTen = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const minuteFormatterFromTen = new Intl.NumberFormat("de-DE", {
  maximumFractionDigits: 0,
});

const hourFormatter = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export interface MonthOption {
  readonly value: string;
  readonly label: string;
}

export interface SpotPlaySummaryProps {
  readonly client: SpotPlaySummaryClient;
  /** Injizierbare Uhr fuer die Monatsliste; ohne Angabe gilt die reale Uhr. */
  readonly now?: Date;
}

type SummaryState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly data: SpotPlaySummaryData };

function monthValue(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** Aktueller Monat und die elf Monate davor, neueste zuerst. */
export function lastTwelveMonths(now: Date): MonthOption[] {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  const options: MonthOption[] = [];
  for (let offset = 0; offset < 12; offset += 1) {
    const date = new Date(Date.UTC(year, monthIndex - offset, 1));
    const value = monthValue(date);
    if (!MONTH_PATTERN.test(value)) {
      continue;
    }
    options.push({ value, label: monthFormatter.format(date) });
  }
  return options;
}

/**
 * Werbeminuten: ab zehn Minuten ganzzahlig mit Tausenderpunkt, darunter mit
 * genau einer Nachkommastelle.
 */
export function formatMinutes(playedMs: number): string {
  const minutes = playedMs / 60_000;
  return minutes < 10
    ? minuteFormatterUnderTen.format(minutes)
    : minuteFormatterFromTen.format(minutes);
}

/** Bildschirmzeit: Minuten und ab einer Stunde zusaetzlich in Stunden. */
export function formatScreenTime(playedMs: number): string {
  const minutes = playedMs / 60_000;
  const base = formatMinutes(playedMs) + " min";
  if (minutes < 60) {
    return base;
  }
  return base + " (" + hourFormatter.format(minutes / 60) + " h)";
}

function csvField(value: string): string {
  if (/[;"\n\r]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function csvMinutes(playedMs: number): string {
  return (playedMs / 60_000).toFixed(1).replace(".", ",");
}

/**
 * CSV-Kundenbericht: je Kunde Summe der bestaetigten Spots und der
 * Werbeminuten. Semikolon als Trennzeichen, UTF-8-BOM fuer Tabellenprogramme.
 */
export function buildCustomerCsv(summary: SpotPlaySummaryData): string {
  const byCustomer = new Map<string, { spots: number; playedMs: number }>();
  for (const media of summary.perMedia) {
    const customer =
      media.customerName === null || media.customerName.trim() === ""
        ? "unbekannt"
        : media.customerName;
    const entry = byCustomer.get(customer) ?? { spots: 0, playedMs: 0 };
    entry.spots += media.spots;
    entry.playedMs += media.playedMs;
    byCustomer.set(customer, entry);
  }

  const lines = ["Kunde;Spots;Werbeminuten"];
  for (const customer of [...byCustomer.keys()].sort((a, b) =>
    a.localeCompare(b, "de"),
  )) {
    const entry = byCustomer.get(customer);
    if (entry === undefined) {
      continue;
    }
    lines.push(
      [
        csvField(customer),
        String(entry.spots),
        csvMinutes(entry.playedMs),
      ].join(";"),
    );
  }
  return "\uFEFF" + lines.join("\n") + "\n";
}

/** Weitere sprechende Namen fuer denselben Bericht. */
export const createCustomerCsv = buildCustomerCsv;
export const customerCsv = buildCustomerCsv;

function downloadCustomerCsv(summary: SpotPlaySummaryData): void {
  if (typeof URL.createObjectURL !== "function") {
    return;
  }
  const csv = buildCustomerCsv(summary);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "kundenbericht-" + summary.month + ".csv";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

function summaryFetcher(
  client: SpotPlaySummaryClient,
): (month: string) => Promise<SpotPlaySummaryData> {
  if (typeof client.getMonthlySummary === "function") {
    return (month) => client.getMonthlySummary!(month);
  }
  if (typeof client.getSummary === "function") {
    return (month) => client.getSummary!(month);
  }
  return () =>
    Promise.reject(
      new Error("Der Client der Monatsuebersicht hat keine lesende Methode."),
    );
}

function taxiLabel(taxiId: string, displayName: string | null): string {
  return displayName === null || displayName.trim() === ""
    ? taxiId
    : displayName;
}

function mediaLabel(mediaId: string, displayName: string | null): string {
  return displayName === null || displayName.trim() === ""
    ? mediaId
    : displayName;
}

function customerLabel(customerName: string | null): string {
  return customerName === null || customerName.trim() === ""
    ? "unbekannt"
    : customerName;
}

function isEmptySummary(summary: SpotPlaySummaryData): boolean {
  return (
    summary.totals.spots === 0 &&
    summary.perTaxi.length === 0 &&
    summary.perMedia.length === 0
  );
}

function messageFor(error: unknown): string {
  return isAdminApiError(error) ? error.message : UNEXPECTED_MESSAGE;
}

export function SpotPlaySummary({
  client,
  now,
}: SpotPlaySummaryProps) {
  const options = useMemo(
    () => lastTwelveMonths(now ?? new Date()),
    [now],
  );
  const [month, setMonth] = useState(() => options[0]?.value ?? "");
  const [state, setState] = useState<SummaryState>({ kind: "loading" });

  const fetchSummary = useMemo(() => summaryFetcher(client), [client]);
  const mountedRef = useRef(true);
  const seqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      seqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (month === "") {
      return;
    }
    const seq = ++seqRef.current;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const data = await fetchSummary(month);
        if (!mountedRef.current || seq !== seqRef.current) {
          return;
        }
        setState({ kind: "ready", data });
      } catch (error) {
        if (!mountedRef.current || seq !== seqRef.current) {
          return;
        }
        // Ein Fehler ersetzt das Ergebnis vollstaendig; alte Zahlen bleiben
        // nicht als aktuelle Monatsuebersicht stehen.
        setState({ kind: "error", message: messageFor(error) });
      }
    })();
  }, [fetchSummary, month]);

  function handleMonthChange(event: ChangeEvent<HTMLSelectElement>) {
    setMonth(event.target.value);
  }

  const stateAttribute =
    state.kind === "ready"
      ? isEmptySummary(state.data)
        ? "empty"
        : "ready"
      : state.kind;

  return (
    <section
      aria-labelledby="spot-summary-heading"
      data-spot-summary-state={stateAttribute}
    >
      <h3 id="spot-summary-heading">Abspielnachweis</h3>
      <p>
        Abspielnachweise je Monat: Spots, Werbeminuten, Taxis mit Werbung und
        Bildschirmzeit je Werbevideo. Spots sind gemeldete, abgeschlossene
        Wiedergaben – keine Sichtkontakte.
      </p>

      <p>
        <label htmlFor="spot-summary-month">Monat</label>{" "}
        <select
          id="spot-summary-month"
          name="month"
          value={month}
          onChange={handleMonthChange}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </p>

      {state.kind === "loading" ? (
        <p role="status">Abspielnachweis wird geladen …</p>
      ) : null}

      {state.kind === "error" ? (
        <p role="alert" data-spot-summary-state="error">
          {state.message}
        </p>
      ) : null}

      {state.kind === "ready" && !isEmptySummary(state.data) ? (
        <>
          <dl>
            <dt>Spots gesamt</dt>
            <dd>{state.data.totals.spots}</dd>
            <dt>Werbeminuten</dt>
            <dd>{formatMinutes(state.data.totals.playedMs)}</dd>
            <dt>Taxis mit Werbung</dt>
            <dd>{state.data.totals.taxis}</dd>
          </dl>

          {state.data.lastReceivedAt === null ? null : (
            <p>Letzter Eingang (UTC): {state.data.lastReceivedAt}</p>
          )}

          <section aria-labelledby="spot-summary-taxi-heading">
            <h4 id="spot-summary-taxi-heading">Minuten je Taxi</h4>
            {state.data.perTaxi.length === 0 ? (
              <p>Keine Taxizuordnung in diesem Monat.</p>
            ) : (
              <table>
                <caption>Pro Taxi</caption>
                <thead>
                  <tr>
                    <th scope="col">Taxi</th>
                    <th scope="col">Spots</th>
                    <th scope="col">Minuten</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.perTaxi.map((row) => (
                    <tr key={row.taxiId}>
                      <td>{taxiLabel(row.taxiId, row.displayName)}</td>
                      <td>{row.spots}</td>
                      <td>{formatMinutes(row.playedMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section aria-labelledby="spot-summary-media-heading">
            <h4 id="spot-summary-media-heading">Bildschirmzeit je Werbevideo</h4>
            {state.data.perMedia.length === 0 ? (
              <p>Keine Werbevideos in diesem Monat.</p>
            ) : (
              <table>
                <caption>Pro Werbevideo</caption>
                <thead>
                  <tr>
                    <th scope="col">Kunde</th>
                    <th scope="col">Werbevideo</th>
                    <th scope="col">Spots</th>
                    <th scope="col">Bildschirmzeit</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.perMedia.map((row) => (
                    <tr key={row.mediaId}>
                      <td>{customerLabel(row.customerName)}</td>
                      <td>{mediaLabel(row.mediaId, row.displayName)}</td>
                      <td>{row.spots}</td>
                      <td>{formatScreenTime(row.playedMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <p>
            <button
              type="button"
              onClick={() => downloadCustomerCsv(state.data)}
            >
              CSV-Kundenbericht
            </button>
          </p>
        </>
      ) : null}

      {state.kind === "ready" && isEmptySummary(state.data) ? (
        <p data-spot-summary-state="empty">
          Keine Spots im gewählten Monat – für diesen Monat liegen keine
          Abspielnachweise vor.
        </p>
      ) : null}
    </section>
  );
}
