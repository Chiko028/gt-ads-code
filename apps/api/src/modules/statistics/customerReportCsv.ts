/**
 * CX-051 / R-406: duenner CSV-Serializer fuer den Kundenbericht.
 *
 * Format: UTF-8, Komma als Trenner, CRLF als Zeilenende, jedes Feld
 * durchgehend in Anfuehrungszeichen, eingebettete Anfuehrungszeichen doppelt.
 * Benutzerkontrollierte Textzellen mit fuehrendem Formelzeichen (auch nach
 * fuehrendem Leerraum oder Steuerzeichen) werden mit einem Apostroph
 * neutralisiert, damit Tabellenkalkulationen sie nie als Formel ausfuehren.
 *
 * Schaetzwerte werden nur mit is_estimate=true und nichtleerer
 * Methodenkennung ausgegeben; ein unmarkierter oder widerspruechlicher Wert
 * ist ein Fehler und keine Zeile.
 */
import {
  CUSTOMER_REPORT_MEASUREMENT,
  type CustomerReportCompleteness,
  type CustomerReportRow,
} from "./customerReport.js";

/** Feste Spaltenreihenfolge des Berichts. */
export const CUSTOMER_REPORT_COLUMNS = Object.freeze([
  "customer_id",
  "campaign_id",
  "campaign_name",
  "from_utc",
  "to_utc",
  "plays_reported",
  "measurement",
  "is_estimate",
  "estimate_method",
  "completeness",
  "data_as_of",
] as const);

const COMPLETENESS_VALUES: ReadonlySet<CustomerReportCompleteness> = new Set([
  "complete",
  "incomplete",
  "unknown",
]);

/** Fuehrendes Formelzeichen, auch hinter Leerraum/Steuerzeichen. */
const FORMULA_PREFIX = /^[\s\u0000-\u001f\u007f\u0080-\u009f]*[=+\-@]/;

/** Setzt vor eine gefaehrliche Textzelle ein Apostroph. */
export function neutralizeFormula(value: string): string {
  return FORMULA_PREFIX.test(value) ? "'" + value : value;
}

/** Quotet ein Feld konsistent und verdoppelt innere Anfuehrungszeichen. */
export function escapeCsvField(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

function textField(value: string): string {
  return escapeCsvField(neutralizeFormula(value));
}

function assertRow(row: CustomerReportRow): void {
  if (row.measurement !== CUSTOMER_REPORT_MEASUREMENT) {
    throw new Error("Unbekannte Messdefinition im Kundenbericht.");
  }
  if (!Number.isInteger(row.plays_reported) || row.plays_reported < 0) {
    throw new Error("Ungueltige Wiedergabezahl im Kundenbericht.");
  }
  if (!COMPLETENESS_VALUES.has(row.completeness)) {
    throw new Error("Unbekannte Vollstaendigkeitskennzeichnung im Kundenbericht.");
  }
  if (row.is_estimate && row.estimate_method.trim().length === 0) {
    // Niemals eine Schaezung ohne Methodenkennung ausgeben.
    throw new Error("Schaetzwert ohne Methodenkennung im Kundenbericht.");
  }
  if (!row.is_estimate && row.estimate_method.length > 0) {
    throw new Error("Methodenkennung ohne Schaetzkennzeichnung im Kundenbericht.");
  }
}

function serializeRow(row: CustomerReportRow): string {
  assertRow(row);
  return [
    textField(row.customer_id),
    textField(row.campaign_id),
    textField(row.campaign_name),
    textField(row.from_utc),
    textField(row.to_utc),
    String(row.plays_reported),
    textField(row.measurement),
    row.is_estimate ? "true" : "false",
    textField(row.estimate_method),
    textField(row.completeness),
    textField(row.data_as_of),
  ].join(",");
}

/**
 * Liefert die vollstaendige CSV-Datei. Ein leeres Ergebnis besteht nur aus
 * der Kopfzeile (plus abschliessendem CRLF); es wird nie gekuerzt.
 */
export function serializeCustomerReportCsv(
  rows: readonly CustomerReportRow[],
): string {
  const header = CUSTOMER_REPORT_COLUMNS.map((column) => escapeCsvField(column)).join(",");
  const lines = [header, ...rows.map(serializeRow)];
  return lines.join("\r\n") + "\r\n";
}
