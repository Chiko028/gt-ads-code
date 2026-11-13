/**
 * Seiteneffektfreier Alarm-Berichtsadapter (CX-020 v2, R-003).
 *
 * Der Adapter liest weder Datenbank noch Netzwerk und kennt weder Episoden-
 * verwaltung noch Versand. Er nimmt ausschliesslich bereits gelieferte
 * Alarm- und Zustellzustaende entgegen und bildet daraus einen begrenzten,
 * geheimnisfreien JSON-Bericht. Zusaetzliche, verschachtelte oder rohe
 * Eingabedetails werden nie uebernommen.
 *
 * Es gibt keine Erfolgsaussage ueber die Alarmierungsanlage: valid beschreibt
 * ausschliesslich die formale Gueltigkeit dieses Berichts.
 */

export const ALARM_REPORT_SCHEMA_VERSION = 1 as const;

/** Fester Fehlercode des ungueltigen Berichts. */
export const ALARM_REPORT_INVALID_ERROR = "INVALID_ALARM_REPORT" as const;

/** Zustand der Alarmepisode; nur diese beiden Werte sind zulaessig. */
export type AlarmReportEpisodeState = "open" | "resolved";

/** Zustellzustand; nur diese sechs Werte sind zulaessig. */
export type AlarmReportDeliveryState =
  | "pending"
  | "retryable"
  | "delivered"
  | "failed"
  | "blocked"
  | "unknown";

/**
 * Zustellnachweis des Aufrufers.
 *
 * deliveryConfirmed ist der ausdrueckliche Erfolgsnachweis und muss fuer
 * deliveryState = "delivered" exakt true sein. Alle anderen Zustaende duerfen
 * weder einen Erfolgsnachweis noch deliveredAt mitfuehren.
 */
export interface AlarmReportDeliveryInput {
  state?: unknown;
  deliveryConfirmed?: unknown;
  deliveredAt?: unknown;
}

/**
 * Gelieferter Alarm- und Zustellzustand.
 *
 * Die Felder sind bewusst unknown: der Adapter prueft sie zur Laufzeit und
 * gibt nie ungepruefte Werte weiter. Ein fehlender Zustellstatus gilt als
 * "unknown"; alle anderen fehlenden Pflichtfelder machen den Bericht ungueltig.
 */
export interface AlarmReportInput {
  alarmId?: unknown;
  resourceId?: unknown;
  errorCode?: unknown;
  episodeState?: unknown;
  occurredAt?: unknown;
  delivery?: unknown;
}

/** Ungueltiger Bericht: ausschliesslich diese drei Felder. */
export interface InvalidAlarmReport {
  schemaVersion: typeof ALARM_REPORT_SCHEMA_VERSION;
  valid: false;
  reportError: typeof ALARM_REPORT_INVALID_ERROR;
}

/** Gueltiger Bericht: ausschliesslich diese zehn Felder. */
export interface ValidAlarmReport {
  schemaVersion: typeof ALARM_REPORT_SCHEMA_VERSION;
  valid: true;
  alarmId: string;
  resourceId: string;
  errorCode: string;
  episodeState: AlarmReportEpisodeState;
  occurredAt: string;
  deliveryState: AlarmReportDeliveryState;
  deliveredAt: string | null;
  reportError: null;
}

export type AlarmReport = ValidAlarmReport | InvalidAlarmReport;

/** ASCII-Kennungen: Buchstaben, Ziffern, Unterstrich, Bindestrich; 1..64. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Fehlercode: ausschliesslich Grossbuchstaben, Ziffern, Unterstrich; 1..64. */
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;
/**
 * ISO-8601-Zeitpunkt mit expliziter Zeitzone. Die Gruppen werden zusaetzlich
 * gegen den Kalender geprueft, damit z. B. der 30. Februar nicht durch eine
 * Datumskorrektur akzeptiert wird.
 */
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

const DELIVERY_STATES: ReadonlySet<string> = new Set([
  "pending",
  "retryable",
  "delivered",
  "failed",
  "blocked",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidReport(): InvalidAlarmReport {
  return {
    schemaVersion: ALARM_REPORT_SCHEMA_VERSION,
    valid: false,
    reportError: ALARM_REPORT_INVALID_ERROR,
  };
}

interface NormalizedTimestamp {
  /** Als UTC serialisierter Zeitpunkt. */
  iso: string;
  /** Vergleichszeit in Millisekunden seit der Epoche. */
  milliseconds: number;
}

/**
 * Prueft einen Zeitpunkt streng und normalisiert ihn nach UTC.
 *
 * Akzeptiert nur vollstaendige ISO-8601-Zeitpunkte mit expliziter Zeitzone.
 * Nicht existierende Kalendertage und unzulaessige Uhrzeiten werden verworfen,
 * statt sie stillschweigend zu korrigieren.
 */
function normalizeTimestamp(value: unknown): NormalizedTimestamp | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = TIMESTAMP_PATTERN.exec(value);
  if (match === null) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const zone = match[8];

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  let offsetMinutes = 0;
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      return null;
    }
    const sign = zone.startsWith("-") ? -1 : 1;
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }

  const millisecondsPart = Number(fraction.padEnd(3, "0").slice(0, 3));
  const utcMilliseconds =
    Date.UTC(year, month - 1, day, hour, minute, second, millisecondsPart) -
    offsetMinutes * 60_000;
  if (!Number.isFinite(utcMilliseconds)) {
    return null;
  }

  // Gegenprobe in der angegebenen lokalen Zone: weicht der zurueckgerechnete
  // Kalender von der Eingabe ab, war das Datum nicht existent (z. B. 30.02.).
  const local = new Date(utcMilliseconds + offsetMinutes * 60_000);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second
  ) {
    return null;
  }

  return {
    iso: new Date(utcMilliseconds).toISOString(),
    milliseconds: utcMilliseconds,
  };
}

function readEpisodeState(value: unknown): AlarmReportEpisodeState | null {
  if (value === "open" || value === "resolved") {
    return value;
  }
  return null;
}

/**
 * Liest den Zustellzustand. Ein fehlender Status ist "unknown"; ein
 * unbekannter oder nicht-textlicher Status ist ungueltige Eingabe und wird
 * nicht als Freitext weitergegeben.
 */
function readDeliveryState(value: unknown): AlarmReportDeliveryState | null {
  if (value === undefined || value === null) {
    return "unknown";
  }
  if (typeof value === "string" && DELIVERY_STATES.has(value)) {
    return value as AlarmReportDeliveryState;
  }
  return null;
}

/**
 * Bildet einen festen Bericht aus einem gelieferten Alarm- und Zustellzustand.
 *
 * Gueltig ist der Bericht nur, wenn alle Pflichtangaben formal zulaessig sind,
 * der Zeitpunkt kalendarisch existiert und der Zustellnachweis zum
 * Zustellstatus passt. "delivered" verlangt einen ausdruecklichen
 * Erfolgsnachweis und ein deliveredAt, das nicht vor occurredAt liegt. Kein
 * anderer Status darf Erfolgsnachweis oder deliveredAt mitfuehren. Behoben und
 * zugestellt bleiben unabhaengig: eine behobene Episode kann fehlgeschlagen
 * zugestellt sein.
 */
export function buildAlarmReport(input: AlarmReportInput): AlarmReport {
  const source: Record<string, unknown> = isRecord(input) ? input : {};

  const alarmId = source.alarmId;
  if (typeof alarmId !== "string" || !ID_PATTERN.test(alarmId)) {
    return invalidReport();
  }

  const resourceId = source.resourceId;
  if (typeof resourceId !== "string" || !ID_PATTERN.test(resourceId)) {
    return invalidReport();
  }

  const errorCode = source.errorCode;
  if (typeof errorCode !== "string" || !ERROR_CODE_PATTERN.test(errorCode)) {
    return invalidReport();
  }

  const episodeState = readEpisodeState(source.episodeState);
  if (episodeState === null) {
    return invalidReport();
  }

  const occurredAt = normalizeTimestamp(source.occurredAt);
  if (occurredAt === null) {
    return invalidReport();
  }

  const rawDelivery = source.delivery;
  if (
    rawDelivery !== undefined &&
    rawDelivery !== null &&
    !isRecord(rawDelivery)
  ) {
    return invalidReport();
  }
  const delivery: Record<string, unknown> | undefined = isRecord(rawDelivery)
    ? rawDelivery
    : undefined;
  const deliveryState = readDeliveryState(delivery?.state);
  if (deliveryState === null) {
    return invalidReport();
  }

  const confirmedRaw = delivery?.deliveryConfirmed;
  const confirmedPresent = confirmedRaw !== undefined && confirmedRaw !== null;
  if (confirmedPresent && typeof confirmedRaw !== "boolean") {
    return invalidReport();
  }

  const deliveredAtRaw = delivery?.deliveredAt;
  const deliveredAtPresent =
    deliveredAtRaw !== undefined && deliveredAtRaw !== null;

  let deliveredAt: string | null = null;
  if (deliveredAtPresent) {
    const normalizedDeliveredAt = normalizeTimestamp(deliveredAtRaw);
    if (normalizedDeliveredAt === null) {
      return invalidReport();
    }
    if (deliveryState !== "delivered") {
      // Widerspruch: nur eine erfolgreiche Zustellung darf deliveredAt fuehren.
      return invalidReport();
    }
    if (normalizedDeliveredAt.milliseconds < occurredAt.milliseconds) {
      return invalidReport();
    }
    deliveredAt = normalizedDeliveredAt.iso;
  }

  if (deliveryState === "delivered") {
    if (confirmedRaw !== true || deliveredAt === null) {
      return invalidReport();
    }
  } else if (confirmedRaw === true) {
    // Widerspruch: kein anderer Status darf einen Erfolgsnachweis mitfuehren.
    return invalidReport();
  }

  return {
    schemaVersion: ALARM_REPORT_SCHEMA_VERSION,
    valid: true,
    alarmId,
    resourceId,
    errorCode,
    episodeState,
    occurredAt: occurredAt.iso,
    deliveryState,
    deliveredAt,
    reportError: null,
  };
}

/** Serialisiert ausschliesslich den festen Bericht als JSON. */
export function serializeAlarmReport(input: AlarmReportInput): string {
  return JSON.stringify(buildAlarmReport(input));
}

