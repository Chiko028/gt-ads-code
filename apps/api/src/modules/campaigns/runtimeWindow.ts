/**
 * CX-004 / GT-ADS-002 (WP-208): Validierung von Kampagnen-Laufzeiten.
 *
 * Dieses Modul ist reine Anwendungslogik ohne Seiteneffekte: keine Systemzeit,
 * keine lokale Zeitzone, keine I/O und keine Statusänderung. Es prüft
 * ausschließlich, ob Start- und Endzeitpunkt gültige Kalenderzeitpunkte im
 * Format YYYY-MM-DDTHH:mm:ss.SSSZ sind und der Endzeitpunkt strikt nach dem
 * Startzeitpunkt liegt.
 *
 * Bewusst NICHT enthalten: Prüfung auf zukünftigen Beginn, Mindest- oder
 * Höchstdauern, Statuslogik oder die Semantik von Ausspielungsgrenzen.
 */

/** Betroffenes Feld eines Laufzeitfehlers. */
export type CampaignRuntimeField = "startAt" | "endAt" | "interval";

/** Stabile Fehlercodes der Laufzeitvalidierung. */
export type CampaignRuntimeErrorCode = "invalid_timestamp" | "invalid_interval";

export interface CampaignRuntimeError {
  field: CampaignRuntimeField;
  code: CampaignRuntimeErrorCode;
  message: string;
}

export type CampaignRuntimeResult =
  | { ok: true; value: { startAt: string; endAt: string } }
  | { ok: false; errors: CampaignRuntimeError[] };

interface ParsedTimestamp {
  /** Absolute Millisekunden seit 1970-01-01T00:00:00.000Z (UTC). */
  epochMilliseconds: number;
  /** Unveränderter Eingabestring. */
  raw: string;
}

const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

const MILLISECONDS_PER_SECOND = 1_000;
const MILLISECONDS_PER_MINUTE = 60 * MILLISECONDS_PER_SECOND;
const MILLISECONDS_PER_HOUR = 60 * MILLISECONDS_PER_MINUTE;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;

const INVALID_TIMESTAMP_MESSAGES: Readonly<Record<"startAt" | "endAt", string>> = {
  startAt:
    'Der Startzeitpunkt muss ein gültiger Kalenderzeitpunkt im Format "YYYY-MM-DDTHH:mm:ss.SSSZ" mit Zeitzone Z sein.',
  endAt:
    'Der Endzeitpunkt muss ein gültiger Kalenderzeitpunkt im Format "YYYY-MM-DDTHH:mm:ss.SSSZ" mit Zeitzone Z sein.',
};

const INVALID_INTERVAL_MESSAGE =
  "Der Endzeitpunkt muss strikt nach dem Startzeitpunkt liegen.";

/** Gregorianische Schaltjahrregel. */
function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

/**
 * Anzahl der Tage seit 1970-01-01 für ein proleptisch gregorianisches Datum
 * (Howard Hinnants "days_from_civil"). Reine Arithmetik, damit weder
 * Date.parse noch die lokale Zeitzone das Ergebnis beeinflussen können.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/**
 * Prüft Syntax UND tatsächliche Kalendergültigkeit. Date.parse wird bewusst
 * nicht verwendet, weil es ungültige Tage (z. B. 2026-02-30) normalisieren
 * würde. Bei Erfolg wird der unveränderte Eingabestring mitgeliefert.
 */
function parseTimestamp(value: unknown): ParsedTimestamp | null {
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
  const millisecond = Number(match[7]);

  // Jahr 0000 ist kein gültiger Kalenderzeitpunkt; 0001-9999 ist zulässig.
  if (year < 1 || year > 9999) {
    return null;
  }

  if (month < 1 || month > 12) {
    return null;
  }

  if (day < 1 || day > daysInMonth(year, month)) {
    return null;
  }

  // Stunde 24 und Schaltsekunden werden nicht normalisiert, sondern abgelehnt.
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  const epochMilliseconds =
    daysFromCivil(year, month, day) * MILLISECONDS_PER_DAY +
    hour * MILLISECONDS_PER_HOUR +
    minute * MILLISECONDS_PER_MINUTE +
    second * MILLISECONDS_PER_SECOND +
    millisecond;

  return { epochMilliseconds, raw: value };
}

function timestampError(field: "startAt" | "endAt"): CampaignRuntimeError {
  return {
    field,
    code: "invalid_timestamp",
    message: INVALID_TIMESTAMP_MESSAGES[field],
  };
}

/**
 * Validiert ein Kampagnen-Laufzeitfenster.
 *
 * - Erfolg: beide Zeitpunkte sind gültig und das Ende liegt strikt nach dem
 *   Start; die ursprünglichen Strings werden unverändert zurückgegeben.
 * - Fehler: feldbezogene Meldungen in fester Reihenfolge (zuerst startAt,
 *   dann endAt). Sind bereits Zeitpunkte ungültig, wird kein zusätzlicher
 *   Intervallfehler erzeugt.
 */
export function validateCampaignRuntime(
  startAt: unknown,
  endAt: unknown,
): CampaignRuntimeResult {
  const start = parseTimestamp(startAt);
  const end = parseTimestamp(endAt);

  const errors: CampaignRuntimeError[] = [];

  if (start === null) {
    errors.push(timestampError("startAt"));
  }

  if (end === null) {
    errors.push(timestampError("endAt"));
  }

  if (start === null || end === null) {
    return { ok: false, errors };
  }

  if (end.epochMilliseconds <= start.epochMilliseconds) {
    return {
      ok: false,
      errors: [
        {
          field: "interval",
          code: "invalid_interval",
          message: INVALID_INTERVAL_MESSAGE,
        },
      ],
    };
  }

  return { ok: true, value: { startAt: start.raw, endAt: end.raw } };
}
