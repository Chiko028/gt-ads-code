/**
 * CX-161: typisierter Dashboard-Client fuer die Monatsauswertung der
 * Abspielnachweise (CX-159).
 *
 * Der Client liest ausschliesslich die vorhandene Adminroute
 * GET /v1/admin/spot-plays/summary?month=JJJJ-MM ueber den gemeinsamen
 * Transport. Die Antwort wird streng auf ihre Struktur geprueft; es gibt
 * keine Aggregation und keine Umdeutung im Browser.
 */
import type { ApiTransport, FetchLike } from "../admin/adminApi";
import { AdminApiError, createApiTransport } from "../admin/adminApi";

/** Relativer Pfad; der gemeinsame Transport ergaenzt standardmaessig /v1. */
export const SPOT_PLAYS_SUMMARY_PATH = "/admin/spot-plays/summary";
/** Sprechender Alias fuer denselben Pfad. */
export const SPOT_PLAY_SUMMARY_PATH = SPOT_PLAYS_SUMMARY_PATH;

const MONTH_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const INVALID_RESPONSE_MESSAGE = "Die Antwort des Servers war ungültig.";
const INVALID_MONTH_MESSAGE = "Bitte einen Monat im Format JJJJ-MM angeben.";

export interface SpotPlaySummaryTotals {
  readonly spots: number;
  readonly playedMs: number;
  readonly taxis: number;
}

export interface SpotPlaySummaryTaxi {
  readonly taxiId: string;
  readonly displayName: string | null;
  readonly spots: number;
  readonly playedMs: number;
}

export interface SpotPlaySummaryMedia {
  readonly mediaId: string;
  readonly displayName: string | null;
  readonly customerName: string | null;
  readonly spots: number;
  readonly playedMs: number;
}

export interface SpotPlaySummary {
  readonly month: string;
  readonly totals: SpotPlaySummaryTotals;
  readonly perTaxi: readonly SpotPlaySummaryTaxi[];
  readonly perMedia: readonly SpotPlaySummaryMedia[];
  readonly lastReceivedAt: string | null;
}

/**
 * Der Client der Monatsuebersicht. Der bevorzugte Methodenname ist
 * getMonthlySummary; getSummary ist als gleichwertiger Alias vorhanden.
 */
export interface SpotPlaySummaryClient {
  readonly getMonthlySummary?: (month: string) => Promise<SpotPlaySummary>;
  readonly getSummary?: (month: string) => Promise<SpotPlaySummary>;
}

/** Alias fuer Aufrufer, die vom Dateinamen spotPlaysApi ausgehen. */
export type SpotPlaysClient = SpotPlaySummaryClient;

export interface SpotPlaySummaryClientOptions {
  /** Vorhandener Transport der Client-Abstraktion. */
  readonly transport?: ApiTransport;
  readonly fetchImpl?: FetchLike;
  readonly baseUrl?: string;
  /** Wird ausschliesslich bei einer 401 der geschuetzten Route aufgerufen. */
  readonly onUnauthorized?: () => void;
}

function invalidResponse(): AdminApiError {
  return new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse();
  }
  return value as Record<string, unknown>;
}

function requiredString(
  source: Record<string, unknown>,
  key: string,
): string {
  const value = source[key];
  if (typeof value !== "string" || value === "") {
    throw invalidResponse();
  }
  return value;
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
): string | null {
  const value = source[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw invalidResponse();
  }
  return value;
}

function requiredCount(
  source: Record<string, unknown>,
  key: string,
): number {
  const value = source[key];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw invalidResponse();
  }
  return value;
}

function requiredMonth(value: unknown): string {
  if (typeof value !== "string" || !MONTH_PATTERN.test(value)) {
    throw invalidResponse();
  }
  return value;
}

function arrayOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw invalidResponse();
  }
  return value;
}

function parseTotals(value: unknown): SpotPlaySummaryTotals {
  const body = recordOf(value);
  return {
    spots: requiredCount(body, "spots"),
    playedMs: requiredCount(body, "played_ms"),
    taxis: requiredCount(body, "taxis"),
  };
}

function parsePerTaxi(value: unknown): SpotPlaySummaryTaxi {
  const row = recordOf(value);
  return {
    taxiId: requiredString(row, "taxi_id"),
    displayName: optionalString(row, "display_name"),
    spots: requiredCount(row, "spots"),
    playedMs: requiredCount(row, "played_ms"),
  };
}

function parsePerMedia(value: unknown): SpotPlaySummaryMedia {
  const row = recordOf(value);
  return {
    mediaId: requiredString(row, "media_id"),
    displayName: optionalString(row, "display_name"),
    customerName: optionalString(row, "customer_name"),
    spots: requiredCount(row, "spots"),
    playedMs: requiredCount(row, "played_ms"),
  };
}

function parseLastReceivedAt(
  source: Record<string, unknown>,
): string | null {
  const value = source.last_received_at;
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value === "") {
    throw invalidResponse();
  }
  return value;
}

/**
 * Strenge Strukturpruefung der Serverantwort. Ist expectedMonth gesetzt,
 * muss die Antwort genau diesen Monat ausweisen.
 */
export function parseSpotPlaySummary(
  value: unknown,
  expectedMonth?: string,
): SpotPlaySummary {
  const body = recordOf(value);
  const month = requiredMonth(body.month);
  if (expectedMonth !== undefined && month !== expectedMonth) {
    throw invalidResponse();
  }
  return {
    month,
    totals: parseTotals(body.totals),
    perTaxi: arrayOf(body.per_taxi).map(parsePerTaxi),
    perMedia: arrayOf(body.per_media).map(parsePerMedia),
    lastReceivedAt: parseLastReceivedAt(body),
  };
}

/** Prueft den Monat vor jedem Netzaufruf. */
export function normalizeSummaryMonth(month: string): string {
  if (typeof month !== "string" || !MONTH_PATTERN.test(month)) {
    throw new AdminApiError("invalid_request", INVALID_MONTH_MESSAGE);
  }
  return month;
}

export function createSpotPlaySummaryClient(
  options: SpotPlaySummaryClientOptions = {},
): SpotPlaySummaryClient {
  const transport =
    options.transport ??
    createApiTransport({
      fetchImpl: options.fetchImpl,
      baseUrl: options.baseUrl,
      onUnauthorized: options.onUnauthorized,
    });

  async function getMonthlySummary(month: string): Promise<SpotPlaySummary> {
    const normalizedMonth = normalizeSummaryMonth(month);
    const path =
      SPOT_PLAYS_SUMMARY_PATH +
      "?month=" +
      encodeURIComponent(normalizedMonth);
    return transport.json(
      path,
      { method: "GET", protectedOperation: true },
      (value) => parseSpotPlaySummary(value, normalizedMonth),
    );
  }

  return { getMonthlySummary, getSummary: getMonthlySummary };
}

/** Alias fuer Aufrufer, die den Plural aus dem Dateinamen erwarten. */
export const createSpotPlaysClient = createSpotPlaySummaryClient;
