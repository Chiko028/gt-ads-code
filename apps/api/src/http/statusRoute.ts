/**
 * CX-048 / R-403: lesender Statusabruf je Taxi und Tablet.
 *
 * Der Adapter liest ausschliesslich vorhandene Persistenz:
 * - Taxi und Tabletzuordnung aus CX-035 (taxis, device_taxi_assignments),
 * - Geraet, letzter Kontakt und Erreichbarkeit aus U5 (devices.last_seen_at,
 *   vorhandene Schwellenlogik deriveConnectivity),
 * - gemeldeten Zustand aus den CX-009-Beobachtungen,
 * - Tagesklassifikation und Datenstand aus den persistierten CX-011-Rollups.
 *
 * Es gibt keine neue Klassifikation, keine Migration und keine
 * Hintergrundauswertung. Die Taxi-Zusammenfassung ist reine
 * Anzeigeaggregation der beiden Tablet-Eintraege. Technische Erreichbarkeit
 * und Fachzustand bleiben getrennte Felder; Offline allein erzeugt weder
 * technischen Fehler noch Fahrzeug-aus.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { ApiError } from "./errors.js";
import { registerJsonRoute } from "./jsonContract.js";
import { createAdminSessionMiddleware } from "../modules/adminAuth/middleware.js";
import type { AdminAuthService } from "../modules/adminAuth/service.js";
import { ensureTaxiActivationSchema } from "../modules/taxiActivation/index.js";
import { deriveConnectivity } from "../modules/devices/status.js";
import {
  CLASSIFICATION_KEYS,
  type ClassificationKey,
} from "../modules/telemetryEvaluation/types.js";
import {
  formatLocalDate,
  parseLocalDate,
  zonedDayRange,
  type LocalDateParts,
} from "../modules/telemetryEvaluation/timeZone.js";

/** Einzige registrierte Route; Kanon des Dashboard-Adapters. */
export const STATUS_PATH = "/v1/admin/status";

/**
 * Bestehende Anzeige- und Auswertungszeitzone (Annahme A-14 der
 * Spezifikation). Ohne Tagesangabe gilt der letzte in dieser Zeitzone
 * abgeschlossene Kalendertag.
 */
export const STATUS_TIME_ZONE = "Europe/Vienna";

export interface StatusRouteDeps {
  pool: Pool;
  adminAuth: AdminAuthService;
  /** Vorhandene Online-Schwelle (GT_ADS_ONLINE_THRESHOLD_S). */
  onlineThresholdSeconds: number;
  /** Injizierbare Serveruhr; ohne Angabe gilt die reale Uhr. */
  now?: () => Date;
}

export interface StatusReportedState {
  vehicle_ready: boolean | null;
  paused: boolean | null;
  playback: "playing" | "stopped" | "unknown" | null;
  technical_fault: boolean | null;
  observed_at: string;
}

export interface StatusDayClassification {
  key: ClassificationKey;
  classes: Record<ClassificationKey, number>;
  local_date: string;
  time_zone: string;
  evaluation_time: string;
  revision: number;
}

export interface StatusTabletEntry {
  device_id: string;
  label: string | null;
  last_seen_at: string | null;
  connectivity: "reachable" | "last_seen" | null;
  reported_state: StatusReportedState | null;
  day_classification: StatusDayClassification | null;
}

/** Anzeigeaggregat; keine fachliche Neuklassifikation. */
export type TaxiStatusValue =
  | ClassificationKey
  | "mixed"
  | "incomplete";

export interface StatusTaxiEntry {
  taxi_id: string;
  display_name: string;
  status: TaxiStatusValue;
  tablets: StatusTabletEntry[];
}

export interface StatusResponse {
  date: string;
  time_zone: string;
  taxi_id: string | null;
  taxis: StatusTaxiEntry[];
}

interface TaxiRow {
  id: string;
  display_name: string;
}

interface AssignmentRow {
  device_id: string;
  taxi_id: string;
}

interface DeviceRow {
  id: string;
  label: string | null;
  last_seen_at: Date | string | null;
}

interface ObservationRow {
  device_id: string;
  occurred_at: Date | string;
  vehicle_ready: boolean | null;
  paused: boolean | null;
  playback: string;
  technical_fault: boolean | null;
}

interface RollupRow {
  device_id: string;
  local_date: Date | string;
  time_zone: string;
  revision: number;
  evaluation_time: Date | string;
  classes: unknown;
}

const MAX_TAXI_ID_LENGTH = 128;

function toIso(value: Date | string): string {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error("Gespeicherter Zeitpunkt ist ungueltig.");
  }
  return new Date(ms).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Kalenderdatum eines Zeitpunkts in der bestehenden Auswertungszeitzone. */
function localDateAt(instant: Date, timeZone: string): LocalDateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of parts) {
    if (part.type === "year") year = Number(part.value);
    else if (part.type === "month") month = Number(part.value);
    else if (part.type === "day") day = Number(part.value);
  }
  return { year, month, day };
}

function previousCalendarDate(date: LocalDateParts): LocalDateParts {
  const probe = new Date(
    Date.UTC(date.year, date.month - 1, date.day) - 86_400_000,
  );
  return {
    year: probe.getUTCFullYear(),
    month: probe.getUTCMonth() + 1,
    day: probe.getUTCDate(),
  };
}

/** Letzter in der Auswertungszeitzone abgeschlossener Kalendertag. */
export function lastCompletedLocalDate(
  serverTime: Date,
  timeZone: string = STATUS_TIME_ZONE,
): string {
  return formatLocalDate(previousCalendarDate(localDateAt(serverTime, timeZone)));
}

/**
 * Liest ausschliesslich taxi_id und date. Mehrfach gesetzte Parameter werden
 * von Fastify als Array geliefert und damit wie jeder unbekannte oder
 * ungueltige Wert abgewiesen.
 */
function parseStatusQuery(
  query: unknown,
  serverTime: Date,
): { taxiId: string | null; date: string } {
  if (!isRecord(query)) {
    throw ApiError.invalidRequest();
  }
  for (const key of Object.keys(query)) {
    if (key !== "taxi_id" && key !== "date") {
      throw ApiError.invalidRequest();
    }
  }

  let taxiId: string | null = null;
  const rawTaxiId = query.taxi_id;
  if (rawTaxiId !== undefined) {
    if (
      typeof rawTaxiId !== "string" ||
      rawTaxiId.trim() === "" ||
      Array.from(rawTaxiId.trim()).length > MAX_TAXI_ID_LENGTH
    ) {
      throw ApiError.invalidRequest();
    }
    taxiId = rawTaxiId.trim();
  }

  let date: string;
  const rawDate = query.date;
  if (rawDate === undefined) {
    date = lastCompletedLocalDate(serverTime);
  } else {
    if (typeof rawDate !== "string") {
      throw ApiError.invalidRequest();
    }
    try {
      date = formatLocalDate(parseLocalDate(rawDate));
    } catch {
      throw ApiError.invalidRequest();
    }
  }

  return { taxiId, date };
}

function parseClasses(value: unknown): Record<ClassificationKey, number> {
  const result = {} as Record<ClassificationKey, number>;
  const source = isRecord(value) ? value : {};
  for (const key of CLASSIFICATION_KEYS) {
    const raw = source[key];
    result[key] =
      typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
  }
  return result;
}

/** Anzeige der gespeicherten Tagesklassifikation: laengste Klasse. */
function dominantClass(
  classes: Record<ClassificationKey, number>,
): ClassificationKey {
  let bestKey: ClassificationKey = "unknown";
  let bestValue = -1;
  for (const key of CLASSIFICATION_KEYS) {
    if (classes[key] > bestValue) {
      bestValue = classes[key];
      bestKey = key;
    }
  }
  return bestKey;
}

/**
 * Reine Anzeigeaggregation der Tablet-Tagesklassifikationen.
 * - unvollstaendige Zuordnung (nicht genau zwei aktive Tablets) -> incomplete
 * - fehlende Auswertung eines Tablets -> unknown
 * - gleiche bekannte Klassifikation -> diese Klassifikation
 * - unterschiedliche Klassifikationen -> mixed
 * Die technische Erreichbarkeit fliesst bewusst nicht ein.
 */
export function summarizeTaxiStatus(
  tablets: readonly { day_classification: StatusDayClassification | null }[],
): TaxiStatusValue {
  if (tablets.length !== 2) {
    return "incomplete";
  }
  const keys = tablets.map((tablet) =>
    tablet.day_classification === null
      ? null
      : tablet.day_classification.key,
  );
  if (keys.some((key) => key === null)) {
    return "unknown";
  }
  const first = keys[0] as ClassificationKey;
  return keys.every((key) => key === first) ? first : "mixed";
}

function toReportedState(row: ObservationRow | undefined): StatusReportedState | null {
  if (row === undefined) {
    return null;
  }
  const playback = row.playback;
  if (playback !== "playing" && playback !== "stopped" && playback !== "unknown") {
    throw new Error("Gespeicherter Wiedergabezustand ist ungueltig.");
  }
  return {
    vehicle_ready: row.vehicle_ready,
    paused: row.paused,
    playback,
    technical_fault: row.technical_fault,
    observed_at: toIso(row.occurred_at),
  };
}

function toDayClassification(
  row: RollupRow | undefined,
): StatusDayClassification | null {
  if (row === undefined) {
    return null;
  }
  const classes = parseClasses(row.classes);
  const localDate =
    typeof row.local_date === "string"
      ? row.local_date.slice(0, 10)
      : row.local_date.toISOString().slice(0, 10);
  return {
    key: dominantClass(classes),
    classes,
    local_date: localDate,
    time_zone: row.time_zone,
    evaluation_time: toIso(row.evaluation_time),
    revision: row.revision,
  };
}

async function loadStatus(
  deps: StatusRouteDeps,
  query: unknown,
): Promise<StatusResponse> {
  const serverTime = (deps.now ?? (() => new Date()))();
  const { taxiId, date } = parseStatusQuery(query, serverTime);

  await ensureTaxiActivationSchema(deps.pool);

  const taxiParams: unknown[] = [];
  let taxiFilter = "";
  if (taxiId !== null) {
    taxiParams.push(taxiId);
    taxiFilter = " where id = $1";
  }
  const taxis = await deps.pool.query<TaxiRow>(
    "select id, display_name from taxis" + taxiFilter + " order by id asc",
    taxiParams,
  );
  if (taxiId !== null && taxis.rows.length === 0) {
    throw ApiError.notFound();
  }

  const taxiIds = taxis.rows.map((row) => row.id);
  if (taxiIds.length === 0) {
    return { date, time_zone: STATUS_TIME_ZONE, taxi_id: taxiId, taxis: [] };
  }

  const assignments = await deps.pool.query<AssignmentRow>(
    [
      "select device_id::text as device_id, taxi_id",
      "  from device_taxi_assignments",
      " where taxi_id = any($1::text[])",
      "   and active = true",
      " order by taxi_id asc, device_id asc",
    ].join("\n"),
    [taxiIds],
  );

  const deviceIds = [
    ...new Set(assignments.rows.map((row) => row.device_id)),
  ];
  if (deviceIds.length === 0) {
    return {
      date,
      time_zone: STATUS_TIME_ZONE,
      taxi_id: taxiId,
      taxis: taxis.rows.map((row) => ({
        taxi_id: row.id,
        display_name: row.display_name,
        status: "incomplete" as const,
        tablets: [],
      })),
    };
  }

  const dateParts = parseLocalDate(date);
  const { startMs, endMs } = zonedDayRange(dateParts, STATUS_TIME_ZONE);

  const [devices, observations, rollups] = await Promise.all([
    deps.pool.query<DeviceRow>(
      [
        "select id::text as id, label, last_seen_at",
        "  from devices",
        " where id = any($1::uuid[])",
      ].join("\n"),
      [deviceIds],
    ),
    deps.pool.query<ObservationRow>(
      [
        "select distinct on (device_id)",
        "       device_id::text as device_id, occurred_at, vehicle_ready,",
        "       paused, playback, technical_fault",
        "  from telemetry_observations",
        " where device_id = any($1::uuid[])",
        "   and occurred_at >= $2::timestamptz",
        "   and occurred_at < $3::timestamptz",
        " order by device_id, occurred_at desc, event_id desc",
      ].join("\n"),
      [
        deviceIds,
        new Date(startMs).toISOString(),
        new Date(endMs).toISOString(),
      ],
    ),
    deps.pool.query<RollupRow>(
      [
        "select distinct on (device_id)",
        "       device_id::text as device_id, local_date::text as local_date,",
        "       time_zone, revision, evaluation_time, classes",
        "  from telemetry_daily_rollups",
        " where device_id = any($1::uuid[])",
        "   and local_date = $2::date",
        "   and time_zone = $3",
        " order by device_id, evaluation_time desc, revision desc",
      ].join("\n"),
      [deviceIds, date, STATUS_TIME_ZONE],
    ),
  ]);

  const deviceById = new Map(devices.rows.map((row) => [row.id, row]));
  const observationByDevice = new Map(
    observations.rows.map((row) => [row.device_id, row]),
  );
  const rollupByDevice = new Map(
    rollups.rows.map((row) => [row.device_id, row]),
  );

  const assignmentsByTaxi = new Map<string, string[]>();
  for (const row of assignments.rows) {
    const list = assignmentsByTaxi.get(row.taxi_id) ?? [];
    list.push(row.device_id);
    assignmentsByTaxi.set(row.taxi_id, list);
  }

  const result: StatusTaxiEntry[] = taxis.rows.map((taxi) => {
    const assigned = (assignmentsByTaxi.get(taxi.id) ?? []).slice(0, 2);
    const tablets: StatusTabletEntry[] = assigned.map((deviceId) => {
      const device = deviceById.get(deviceId);
      const lastSeenRaw = device?.last_seen_at ?? null;
      const lastSeenAt =
        lastSeenRaw === null || lastSeenRaw === undefined
          ? null
          : toIso(lastSeenRaw);
      return {
        device_id: deviceId,
        label: device?.label ?? null,
        last_seen_at: lastSeenAt,
        connectivity:
          lastSeenAt === null
            ? null
            : deriveConnectivity({
                lastSeenAt: new Date(lastSeenAt),
                serverTime,
                onlineThresholdSeconds: deps.onlineThresholdSeconds,
              }),
        reported_state: toReportedState(observationByDevice.get(deviceId)),
        day_classification: toDayClassification(rollupByDevice.get(deviceId)),
      };
    });
    return {
      taxi_id: taxi.id,
      display_name: taxi.display_name,
      status: summarizeTaxiStatus(tablets),
      tablets,
    };
  });

  return { date, time_zone: STATUS_TIME_ZONE, taxi_id: taxiId, taxis: result };
}

/**
 * Registriert GET /v1/admin/status genau einmal. Der Rechtekern klassifiziert
 * die Route als menschliche Leseaktion devices.read; der vorhandene
 * Sitzungsschutz gilt zusaetzlich.
 */
export function registerStatusRoute(
  app: FastifyInstance,
  deps: StatusRouteDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);

  registerJsonRoute(app, {
    method: "GET",
    url: STATUS_PATH,
    onRequest: [sessionGuard],
    handler: async (request, reply) => {
      if (request.accessPrincipal === undefined) {
        throw ApiError.unauthorized();
      }
      const body = await loadStatus(deps, request.query);
      reply.header("Cache-Control", "no-store");
      reply.code(200).send(body);
    },
  });
}
