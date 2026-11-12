import { EvaluationInputError } from "./errors.js";

/**
 * Zonierte Kalendergrenzen ohne feste UTC-Offsets.
 *
 * Die Umrechnung erfolgt ausschliesslich ueber die IANA-Zeitzonendaten von
 * Intl. Damit werden Sommerzeit und 23-/25-Stunden-Tage korrekt abgebildet.
 */

const DAY_MS = 86_400_000;
const SEARCH_RADIUS_MS = 36 * 3_600_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

export interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

/** Prueft eine verpflichtende IANA-Zeitzone; feste Offset-Schreibweisen sind unzulaessig. */
export function assertIanaTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EvaluationInputError("timeZone ist eine verpflichtende IANA-Zeitzone.");
  }
  const candidate = value.trim();
  if (/^[+-]\d{2}:?\d{2}$/.test(candidate) || /^(?:UTC)?[+-]\d{2}$/.test(candidate)) {
    throw new EvaluationInputError(
      "timeZone muss eine IANA-Zeitzone sein, kein fester UTC-Offset.",
    );
  }
  try {
    formatterFor(candidate);
  } catch {
    throw new EvaluationInputError(
      "timeZone ist keine gueltige IANA-Zeitzone: " + candidate,
    );
  }
  return candidate;
}

/** Parst YYYY-MM-DD strikt, inklusive Rueckvergleich gegen den Kalender. */
export function parseLocalDate(value: unknown): LocalDateParts {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new EvaluationInputError("localDate muss die Form YYYY-MM-DD haben.");
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new EvaluationInputError("localDate ist kein gueltiges Kalenderdatum.");
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new EvaluationInputError("localDate ist kein gueltiges Kalenderdatum: " + value);
  }
  return { year, month, day };
}

/** Lokale Tagesnummer (Tage seit 1970-01-01) fuer einen UTC-Instant. */
function localDayNumber(instantMs: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of parts) {
    if (part.type === "year") {
      year = Number(part.value);
    } else if (part.type === "month") {
      month = Number(part.value);
    } else if (part.type === "day") {
      day = Number(part.value);
    }
  }
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

function utcMidnightMs(date: LocalDateParts): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

function nextCalendarDate(date: LocalDateParts): LocalDateParts {
  const next = new Date(utcMidnightMs(date) + DAY_MS);
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

/**
 * Erster UTC-Instant, dessen lokales Datum mindestens date erreicht.
 *
 * Die lokale Tagesnummer ist monoton; deshalb ist eine Binaersuche ueber ein
 * grosszuegiges UTC-Fenster exakt und unabhaengig von festen Offsets.
 */
export function zonedDayStartMs(date: LocalDateParts, timeZone: string): number {
  const target = utcMidnightMs(date) / DAY_MS;
  const lowStart = utcMidnightMs(date) - SEARCH_RADIUS_MS;
  const highStart = utcMidnightMs(date) + SEARCH_RADIUS_MS;
  let low = lowStart;
  let high = highStart;

  if (localDayNumber(high, timeZone) < target) {
    throw new EvaluationInputError("Zonierte Tagesgrenze nicht auffindbar.");
  }
  if (localDayNumber(low, timeZone) >= target) {
    throw new EvaluationInputError("Zonierte Tagesgrenze nicht eindeutig.");
  }

  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    if (localDayNumber(mid, timeZone) >= target) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return high;
}

export interface ZonedDayRange {
  startMs: number;
  endMs: number;
  dayLengthMs: number;
}

/** Zonierte Grenzen eines lokalen Kalendertages; die Laenge ist 23, 24 oder 25 Stunden. */
export function zonedDayRange(
  date: LocalDateParts,
  timeZone: string,
): ZonedDayRange {
  const startMs = zonedDayStartMs(date, timeZone);
  const endMs = zonedDayStartMs(nextCalendarDate(date), timeZone);
  return { startMs, endMs, dayLengthMs: endMs - startMs };
}

export function formatLocalDate(date: LocalDateParts): string {
  return (
    String(date.year).padStart(4, "0") +
    "-" +
    String(date.month).padStart(2, "0") +
    "-" +
    String(date.day).padStart(2, "0")
  );
}
