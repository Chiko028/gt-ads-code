/**
 * CX-050 / R-405: typisierter Dashboard-Client fuer die lesende
 * Statistikroute aus CX-049.
 *
 * Der Client nutzt ausschliesslich die vorhandene same-origin-Cookie-Sitzung
 * ueber den gemeinsamen Transport der bestehenden Client-Abstraktion. Er
 * aggregiert nichts im Browser und veraendert die Antwortsemantik nicht:
 * Wiedergaben und Geraetequalitaet bleiben getrennt, null bleibt unbekannt.
 */
import type { ApiTransport, FetchLike } from "../admin/adminApi";
import { AdminApiError, createApiTransport } from "../admin/adminApi";

/** Relativer Pfad zur vorhandenen Statistikroute (CX-049). */
export const STATISTICS_API_PATH = "/admin/statistics";

export interface StatisticsRequest {
  /** UTC-normalisierter Beginn als ISO-8601-Zeitpunkt. */
  readonly from: string;
  /** UTC-normalisiertes Ende als ISO-8601-Zeitpunkt (exklusiv). */
  readonly to: string;
  readonly campaignId: string | null;
  readonly deviceId: string | null;
  readonly taxiId: string | null;
}

export interface StatisticsFiltersData {
  readonly campaignId: string | null;
  readonly deviceId: string | null;
  readonly taxiId: string | null;
}

export interface PlayRow {
  readonly campaignId: string | null;
  readonly deviceId: string;
  readonly taxiId: string | null;
  readonly playCount: number;
  readonly firstPlayedAt: string;
  readonly lastPlayedAt: string;
}

export interface DeviceQualityRow {
  readonly deviceId: string;
  readonly taxiId: string | null;
  /** 0..1 oder null, wenn kein belastbarer Nenner vorliegt. */
  readonly availabilityRatio: number | null;
  readonly availabilityReason: string | null;
  readonly observedMs: number | null;
  readonly technicalFaultMs: number | null;
  readonly syncErrors: number;
  readonly syncErrorScope: string;
}

export type MissingDayReason = "no_raw_evidence" | "raw_retention_gap";

export interface MissingDay {
  readonly day: string;
  readonly reason: MissingDayReason;
}

export interface StatisticsCompleteness {
  readonly status: "complete" | "incomplete";
  readonly reasons: readonly string[];
  readonly dataAsOf: string;
  readonly missingDays: readonly MissingDay[];
}

export interface MeasurementDefinition {
  readonly interval: string;
  readonly playCount: string;
  readonly campaignAttribution: string;
  readonly taxiAttribution: string;
  readonly availability: string;
  readonly syncErrors: string;
  readonly excludes: readonly string[];
}

export interface StatisticsResponse {
  readonly from: string;
  readonly to: string;
  readonly generatedAt: string;
  readonly filters: StatisticsFiltersData;
  readonly definition: MeasurementDefinition;
  readonly completeness: StatisticsCompleteness;
  readonly rowLimit: number;
  readonly rowCount: number;
  readonly qualityScope: string;
  readonly plays: readonly PlayRow[];
  readonly deviceQuality: readonly DeviceQualityRow[];
}

export interface StatisticsClient {
  getStatistics(request: StatisticsRequest): Promise<StatisticsResponse>;
}

export interface StatisticsClientOptions {
  /**
   * Vorhandener Transport der Client-Abstraktion. Ohne Angabe wird die
   * gemeinsame Transport-Abstraktion mit den folgenden Optionen erzeugt.
   */
  readonly transport?: ApiTransport;
  readonly fetchImpl?: FetchLike;
  readonly baseUrl?: string;
  /** Wird ausschliesslich bei einer 401 der geschuetzten Route aufgerufen. */
  readonly onUnauthorized?: () => void;
}

const INVALID_RESPONSE_MESSAGE = "Die Antwort des Servers war ungültig.";

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  source: Record<string, unknown>,
  key: string,
): string {
  const value = source[key];
  if (typeof value !== "string") {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return value;
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
): string | null {
  const value = source[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return value;
}

function requiredNumber(
  source: Record<string, unknown>,
  key: string,
): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return value;
}

function optionalNumber(
  source: Record<string, unknown>,
  key: string,
): number | null {
  const value = source[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return value;
}

function arrayOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return value;
}

function parsePlayRow(value: unknown): PlayRow {
  const row = recordOf(value);
  return {
    campaignId: optionalString(row, "campaign_id"),
    deviceId: requiredString(row, "device_id"),
    taxiId: optionalString(row, "taxi_id"),
    playCount: requiredNumber(row, "play_count"),
    firstPlayedAt: requiredString(row, "first_played_at"),
    lastPlayedAt: requiredString(row, "last_played_at"),
  };
}

function parseQualityRow(value: unknown): DeviceQualityRow {
  const row = recordOf(value);
  const scope = requiredString(row, "sync_error_scope");
  return {
    deviceId: requiredString(row, "device_id"),
    taxiId: optionalString(row, "taxi_id"),
    availabilityRatio: optionalNumber(row, "availability_ratio"),
    availabilityReason: optionalString(row, "availability_reason"),
    observedMs: optionalNumber(row, "observed_ms"),
    technicalFaultMs: optionalNumber(row, "technical_fault_ms"),
    syncErrors: requiredNumber(row, "sync_errors"),
    syncErrorScope: scope,
  };
}

function parseMissingDay(value: unknown): MissingDay {
  const day = recordOf(value);
  const reason = requiredString(day, "reason");
  if (reason !== "no_raw_evidence" && reason !== "raw_retention_gap") {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return { day: requiredString(day, "day"), reason };
}

function parseCompleteness(value: unknown): StatisticsCompleteness {
  const body = recordOf(value);
  const status = requiredString(body, "status");
  if (status !== "complete" && status !== "incomplete") {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  const reasons = arrayOf(body.reasons).map((entry) => {
    if (typeof entry !== "string") {
      throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
    }
    return entry;
  });
  return {
    status,
    reasons,
    dataAsOf: requiredString(body, "data_as_of"),
    missingDays: arrayOf(body.missing_days).map(parseMissingDay),
  };
}

function parseDefinition(value: unknown): MeasurementDefinition {
  const body = recordOf(value);
  const excludes = arrayOf(body.excludes).map((entry) => {
    if (typeof entry !== "string") {
      throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
    }
    return entry;
  });
  return {
    interval: requiredString(body, "interval"),
    playCount: requiredString(body, "play_count"),
    campaignAttribution: requiredString(body, "campaign_attribution"),
    taxiAttribution: requiredString(body, "taxi_attribution"),
    availability: requiredString(body, "availability"),
    syncErrors: requiredString(body, "sync_errors"),
    excludes,
  };
}

function parseFilters(value: unknown): StatisticsFiltersData {
  const body = recordOf(value);
  return {
    campaignId: optionalString(body, "campaign_id"),
    deviceId: optionalString(body, "device_id"),
    taxiId: optionalString(body, "taxi_id"),
  };
}

/** Prueft die Antwortstruktur, ohne Werte umzudeuten. */
export function parseStatisticsResponse(value: unknown): StatisticsResponse {
  const body = recordOf(value);
  return {
    from: requiredString(body, "from"),
    to: requiredString(body, "to"),
    generatedAt: requiredString(body, "generated_at"),
    filters: parseFilters(body.filters),
    definition: parseDefinition(body.definition),
    completeness: parseCompleteness(body.completeness),
    rowLimit: requiredNumber(body, "row_limit"),
    rowCount: requiredNumber(body, "row_count"),
    qualityScope: requiredString(body, "quality_scope"),
    plays: arrayOf(body.plays).map(parsePlayRow),
    deviceQuality: arrayOf(body.device_quality).map(parseQualityRow),
  };
}

function queryString(request: StatisticsRequest): string {
  const params = new URLSearchParams();
  params.set("from", request.from);
  params.set("to", request.to);
  if (request.campaignId !== null) {
    params.set("campaign_id", request.campaignId);
  }
  if (request.deviceId !== null) {
    params.set("device_id", request.deviceId);
  }
  if (request.taxiId !== null) {
    params.set("taxi_id", request.taxiId);
  }
  return params.toString();
}

function pickString(
  source: Record<string, unknown>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") {
      return value;
    }
  }
  throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
}

function pickNullableString(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    if (!(key in source)) {
      continue;
    }
    const value = source[key];
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== "string") {
      throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
    }
    return value;
  }
  return null;
}

function pickNumber(
  source: Record<string, unknown>,
  keys: readonly string[],
): number {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
}

function pickNullableNumber(
  source: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    if (!(key in source)) {
      continue;
    }
    const value = source[key];
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
    }
    return value;
  }
  return null;
}

function stringList(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  return arrayOf(value).map((entry) => {
    if (typeof entry !== "string") {
      throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
    }
    return entry;
  });
}

/**
 * Nimmt sowohl die typisierte Clientantwort als auch eine unveraenderte
 * CX-049-JSON-Antwort (snake_case) entgegen. Damit bleibt die Seite an den
 * Backendvertrag gebunden, ohne Feldnamen im Browser umzudeuten.
 */
export function normalizeStatisticsResponse(
  value: unknown,
  fallback: { readonly from?: string; readonly to?: string } = {},
): StatisticsResponse {
  const body = recordOf(value);
  const filters = recordOf(body.filters ?? {});
  const definition = recordOf(body.definition);
  const completeness = recordOf(body.completeness);

  return {
    from: pickNullableString(body, ["from"]) ?? fallback.from ?? "",
    to: pickNullableString(body, ["to"]) ?? fallback.to ?? "",
    generatedAt: pickNullableString(body, ["generatedAt", "generated_at"]) ?? "",
    filters: {
      campaignId: pickNullableString(filters, ["campaignId", "campaign_id"]),
      deviceId: pickNullableString(filters, ["deviceId", "device_id"]),
      taxiId: pickNullableString(filters, ["taxiId", "taxi_id"]),
    },
    definition: {
      interval: pickString(definition, ["interval"]),
      playCount: pickString(definition, ["playCount", "play_count"]),
      campaignAttribution: pickString(definition, [
        "campaignAttribution",
        "campaign_attribution",
      ]),
      taxiAttribution: pickString(definition, [
        "taxiAttribution",
        "taxi_attribution",
      ]),
      availability: pickString(definition, ["availability"]),
      syncErrors: pickString(definition, ["syncErrors", "sync_errors"]),
      excludes: stringList(definition.excludes),
    },
    completeness: {
      status: pickString(completeness, ["status"]) as StatisticsCompleteness["status"],
      reasons: stringList(completeness.reasons),
      dataAsOf: pickString(completeness, ["dataAsOf", "data_as_of"]),
      missingDays: arrayOf(
        completeness.missingDays ?? completeness.missing_days ?? [],
      ).map((entry) => {
        const day = recordOf(entry);
        return {
          day: pickString(day, ["day"]),
          reason: pickString(day, ["reason"]) as MissingDay["reason"],
        };
      }),
    },
    rowLimit: pickNullableNumber(body, ["rowLimit", "row_limit"]) ?? 0,
    rowCount: pickNullableNumber(body, ["rowCount", "row_count"]) ?? 0,
    qualityScope:
      pickNullableString(body, ["qualityScope", "quality_scope"]) ?? "",
    plays: arrayOf(body.plays ?? []).map((entry) => {
      const row = recordOf(entry);
      return {
        campaignId: pickNullableString(row, ["campaignId", "campaign_id"]),
        deviceId: pickString(row, ["deviceId", "device_id"]),
        taxiId: pickNullableString(row, ["taxiId", "taxi_id"]),
        playCount: pickNumber(row, ["playCount", "play_count"]),
        firstPlayedAt: pickString(row, ["firstPlayedAt", "first_played_at"]),
        lastPlayedAt: pickString(row, ["lastPlayedAt", "last_played_at"]),
      };
    }),
    deviceQuality: arrayOf(
      body.deviceQuality ?? body.device_quality ?? [],
    ).map((entry) => {
      const row = recordOf(entry);
      return {
        deviceId: pickString(row, ["deviceId", "device_id"]),
        taxiId: pickNullableString(row, ["taxiId", "taxi_id"]),
        availabilityRatio: pickNullableNumber(row, [
          "availabilityRatio",
          "availability_ratio",
        ]),
        availabilityReason: pickNullableString(row, [
          "availabilityReason",
          "availability_reason",
        ]),
        observedMs: pickNullableNumber(row, ["observedMs", "observed_ms"]),
        technicalFaultMs: pickNullableNumber(row, [
          "technicalFaultMs",
          "technical_fault_ms",
        ]),
        syncErrors: pickNumber(row, ["syncErrors", "sync_errors"]),
        syncErrorScope:
          pickNullableString(row, ["syncErrorScope", "sync_error_scope"]) ?? "",
      };
    }),
  };
}

export function createStatisticsClient(
  options: StatisticsClientOptions = {},
): StatisticsClient {
  const transport =
    options.transport ??
    createApiTransport({
      fetchImpl: options.fetchImpl,
      baseUrl: options.baseUrl,
      onUnauthorized: options.onUnauthorized,
    });

  return {
    async getStatistics(
      request: StatisticsRequest,
    ): Promise<StatisticsResponse> {
      // Transport, Fehleruebersetzung, 401-Behandlung und JSON-Auswertung
      // stammen unveraendert aus der gemeinsamen Client-Abstraktion.
      return transport.json(
        STATISTICS_API_PATH + "?" + queryString(request),
        { method: "GET", protectedOperation: true },
        parseStatisticsResponse,
      );
    },
  };
}

