/**
 * CX-049: strikte Validierung der Statistikabfrage.
 *
 * from/to sind Pflicht und muessen RFC3339-Zeitpunkte mit explizitem Offset
 * sein. Das Intervall ist halb offen [from,to) und hoechstens 31 Tage lang.
 * Unbekannte, mehrfach gesetzte oder ungueltige Parameter werden wie jeder
 * andere Vertragsfehler als gemeinsamer Validierungsfehler abgewiesen.
 */
import { ApiError } from "../../http/errors.js";
import {
  STATISTICS_MAX_RANGE_MS,
  type StatisticsQuery,
} from "./types.js";

const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_ID_LENGTH = 128;

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "from",
  "to",
  "campaign_id",
  "device_id",
  "taxi_id",
]);

function invalid(): never {
  throw ApiError.invalidRequest();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Prueft einen RFC3339-Zeitpunkt mit explizitem Offset (Z oder +hh:mm).
 * Datum und Uhrzeit werden gegen den Kalender geprueft; die stillschweigende
 * Normalisierung von Date.parse (z. B. 30. Februar) wird nicht akzeptiert.
 */
export function parseRfc3339Instant(raw: unknown): { ms: number; iso: string } {
  if (typeof raw !== "string") invalid();
  const match = RFC3339_PATTERN.exec(raw);
  if (match === null) invalid();

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] === undefined ? 0 : Number("0" + match[7].slice(0, 4));
  const offset = match[8]!;

  if (year < 1 || year > 9999) invalid();
  if (month < 1 || month > 12) invalid();
  if (day < 1 || day > 31) invalid();
  if (hour > 23 || minute > 59 || second > 59) invalid();

  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(hour, minute, second, Math.round(fraction * 1000));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hour ||
    probe.getUTCMinutes() !== minute ||
    probe.getUTCSeconds() !== second
  ) {
    invalid();
  }

  let offsetMinutes = 0;
  if (offset !== "Z") {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) invalid();
    const sign = offset[0] === "-" ? -1 : 1;
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }

  const ms = probe.getTime() - offsetMinutes * 60_000;
  if (!Number.isFinite(ms)) invalid();
  return { ms, iso: new Date(ms).toISOString() };
}

function parseCampaignId(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || !UUID_PATTERN.test(raw)) invalid();
  return raw.toLowerCase();
}

function parseDeviceId(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || !UUID_PATTERN.test(raw)) invalid();
  return raw.toLowerCase();
}

function parseTaxiId(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string") invalid();
  const value = raw.trim();
  if (value.length === 0 || Array.from(value).length > MAX_ID_LENGTH) invalid();
  return value;
}

/** Validiert die Query und liefert die normalisierte Abfrage. */
export function parseStatisticsQuery(query: unknown): StatisticsQuery {
  if (!isRecord(query)) invalid();
  for (const key of Object.keys(query)) {
    if (!ALLOWED_KEYS.has(key)) invalid();
  }

  if (query.from === undefined || query.to === undefined) invalid();
  const from = parseRfc3339Instant(query.from);
  const to = parseRfc3339Instant(query.to);

  if (to.ms <= from.ms) invalid();
  if (to.ms - from.ms > STATISTICS_MAX_RANGE_MS) invalid();

  return {
    from: from.iso,
    to: to.iso,
    fromMs: from.ms,
    toMs: to.ms,
    campaignId: parseCampaignId(query.campaign_id),
    deviceId: parseDeviceId(query.device_id),
    taxiId: parseTaxiId(query.taxi_id),
  };
}

