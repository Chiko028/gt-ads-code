/**
 * CX-051 / R-406: gekennzeichneter CSV-Kundenbericht.
 *
 * Der Bericht ist ein duenner Aufsatz auf der vorhandenen, lesenden
 * Wiedergabe-Statistik (CX-049):
 * - Zeitvalidierung, Datenstand und Qualitaetssemantik kommen unveraendert
 *   aus CX-049; es gibt keine zweite Zaehlung und keine neue Persistenz.
 * - Die Statistikquelle wird bereits vor ihrer Zeilenobergrenze auf die
 *   aufgeloesten Kundenkampagnen begrenzt; fremde Kampagnen und deren
 *   Geraete zaehlen nicht mit.
 * - Kunden und Kampagnen werden ueber die vorhandenen CX-032-Tabellen
 *   (customers/campaigns) aufgeloest, einschliesslich archivierter
 *   Kampagnen. Fremde Kunden und fremde Betreiberkontexte liefern generisch
 *   "nicht gefunden".
 * - Gezaehlt werden ausschliesslich gemeldete, abgeschlossene Wiedergaben
 *   (measurement=app_reported_completed_play) je Kampagne, summiert ueber
 *   Geraete und Taxis. Es gibt keine Taxi-Deduplizierung, keine
 *   Personenkontakte und keine OTS-/Reichweiten-/Verguetungswerte.
 * - Es werden keine Schaetzungen erzeugt. Sollte die wiederverwendete Quelle
 *   kuenftig Schaetzwerte liefern, duerfen diese nur mit is_estimate=true
 *   und nichtleerer Methodenkennung erscheinen; Schaetz- und Zaehlwerte
 *   derselben Kampagne werden nie unmarkiert verschmolzen.
 */
import type { Pool } from "pg";
import { ApiError } from "../../http/errors.js";
import {
  StatisticsRowLimitError,
  createStatisticsService,
  type StatisticsService,
} from "./service.js";
import {
  STATISTICS_ROW_LIMIT,
  type PlayRow,
  type StatisticsResponse,
} from "./types.js";
import { parseStatisticsQuery } from "./validation.js";

/** Einzige Messdefinition des Berichts. */
export const CUSTOMER_REPORT_MEASUREMENT = "app_reported_completed_play";

/** Zustand der Berichtsgrundlage; "unknown" heisst: keinerlei Belege. */
export type CustomerReportCompleteness = "complete" | "incomplete" | "unknown";

export interface CustomerReportQuery {
  /** Kanonischer UTC-Zeitpunkt aus der Anfrage. */
  from: string;
  to: string;
  fromMs: number;
  toMs: number;
  customerId: string;
  campaignId: string | null;
}

export interface CustomerReportRow {
  customer_id: string;
  campaign_id: string;
  campaign_name: string;
  from_utc: string;
  to_utc: string;
  plays_reported: number;
  measurement: typeof CUSTOMER_REPORT_MEASUREMENT;
  is_estimate: boolean;
  estimate_method: string;
  completeness: CustomerReportCompleteness;
  data_as_of: string;
}

export interface CustomerReportServiceOptions {
  pool: Pool;
  /** Injizierbare Serveruhr; ohne Angabe gilt die reale Uhr. */
  now?: () => Date;
  /** Obergrenze der Berichtszeilen; Standard ist die CX-049-Grenze. */
  rowLimit?: number;
}

/** Die Ergebniszeilen ueberschreiten die harte Obergrenze. */
export class CustomerReportRowLimitError extends Error {
  constructor() {
    super("Der Kundenbericht ueberschreitet die zulaessige Zeilenobergrenze.");
    this.name = "CustomerReportRowLimitError";
  }
}

/** Die wiederverwendete Quelle liefert nicht kennzeichnungskonforme Werte. */
export class CustomerReportSourceError extends Error {
  constructor() {
    super("Die Statistikquelle liefert nicht kennzeichnungskonforme Werte.");
    this.name = "CustomerReportSourceError";
  }
}

const DAY_MS = 86_400_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const REPORT_QUERY_KEYS: ReadonlySet<string> = new Set([
  "customer_id",
  "from",
  "to",
  "campaign_id",
]);

function invalid(): never {
  throw ApiError.invalidRequest();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUuid(raw: unknown): string {
  if (typeof raw !== "string" || !UUID_PATTERN.test(raw)) invalid();
  return raw.toLowerCase();
}

/**
 * Validiert die Berichtsabfrage. from/to samt halb offenem 31-Tage-Intervall
 * werden unveraendert von CX-049 uebernommen; customer_id ist Pflicht,
 * campaign_id optional und muss eine kanonische UUID sein.
 */
export function parseCustomerReportQuery(query: unknown): CustomerReportQuery {
  if (!isRecord(query)) invalid();
  for (const key of Object.keys(query)) {
    if (!REPORT_QUERY_KEYS.has(key)) invalid();
  }
  if (query.customer_id === undefined) invalid();

  const customerId = parseUuid(query.customer_id);
  const campaignId =
    query.campaign_id === undefined ? null : parseUuid(query.campaign_id);
  // Reine Wiederverwendung: identische Zeitpruefung wie CX-049.
  const times = parseStatisticsQuery({ from: query.from, to: query.to });

  return {
    from: times.from,
    to: times.to,
    fromMs: times.fromMs,
    toMs: times.toMs,
    customerId,
    campaignId,
  };
}

interface CampaignResolutionRow {
  id: string;
  campaign_name: string | null;
}

interface SourceEstimate {
  isEstimate: boolean;
  method: string | null;
}

/**
 * Liest eine optionale Schaetzkennzeichnung aus der wiederverwendeten Quelle.
 * Die aktuelle CX-049-Antwort enthaelt keine solchen Felder; die Pruefung
 * stellt sicher, dass eine spaetere Quelle niemals unmarkiert einfliesst.
 */
function readEstimate(row: PlayRow): SourceEstimate {
  const record = row as unknown as Record<string, unknown>;
  const flag = record.is_estimate;
  const method = record.estimate_method;
  if (flag === undefined || flag === false) {
    if (typeof method === "string" && method.trim().length > 0) {
      throw new CustomerReportSourceError();
    }
    return { isEstimate: false, method: null };
  }
  if (flag !== true) throw new CustomerReportSourceError();
  if (typeof method !== "string" || method.trim().length === 0) {
    throw new CustomerReportSourceError();
  }
  return { isEstimate: true, method };
}

function playCount(row: PlayRow): number {
  const value = row.play_count;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new CustomerReportSourceError();
  }
  return value;
}

interface CampaignAggregate {
  counted: number;
  estimated: number;
  estimateMethod: string | null;
}

function classifyCompleteness(
  statistics: StatisticsResponse,
  fromMs: number,
  toMs: number,
): CustomerReportCompleteness {
  if (statistics.completeness.status === "complete") return "complete";
  // unknown nur, wenn fuer keinen Tag des Zeitraums ein Beleg vorliegt.
  // Einzelne fehlende Tage bleiben incomplete.
  if (statistics.completeness.reasons.includes("missing_raw_evidence")) {
    const firstDay = Math.floor(fromMs / DAY_MS) * DAY_MS;
    let expectedDays = 0;
    for (let cursor = firstDay; cursor < toMs; cursor += DAY_MS) {
      expectedDays += 1;
    }
    if (
      expectedDays > 0 &&
      statistics.completeness.missing_days.length >= expectedDays
    ) {
      return "unknown";
    }
  }
  return "incomplete";
}

export class CustomerReportService {
  private readonly pool: Pool;
  private readonly statistics: StatisticsService;
  private readonly rowLimit: number;

  constructor(options: CustomerReportServiceOptions) {
    this.pool = options.pool;
    this.statistics = createStatisticsService({
      pool: options.pool,
      now: options.now,
    });
    this.rowLimit = options.rowLimit ?? STATISTICS_ROW_LIMIT;
  }

  /**
   * Baut die Berichtszeilen je Kundenkampagne. Es wird nichts gespeichert
   * und nichts abgeschnitten: zu viele Zeilen sind ein Fehler.
   */
  async buildReport(
    query: CustomerReportQuery,
    ownerId: string,
  ): Promise<CustomerReportRow[]> {
    if (typeof ownerId !== "string" || ownerId.length === 0) {
      throw ApiError.unauthorized();
    }

    const customer = await this.pool.query(
      "select 1 from customers where id = $1::uuid",
      [query.customerId],
    );
    if (customer.rowCount === 0) throw ApiError.notFound();

    const campaigns = await this.resolveCampaigns(query, ownerId);
    if (query.campaignId !== null && campaigns.length === 0) {
      // Fremde oder unbekannte Kampagne: bewusst derselbe Fehler.
      throw ApiError.notFound();
    }
    if (campaigns.length > this.rowLimit) {
      throw new CustomerReportRowLimitError();
    }
    if (campaigns.length === 0) return [];

    const statistics = await this.statistics.getStatistics({
      from: query.from,
      to: query.to,
      fromMs: query.fromMs,
      toMs: query.toMs,
      campaignId: query.campaignId,
      campaignIds: campaigns.map((campaign) => campaign.id),
      deviceId: null,
      taxiId: null,
    });

    const campaignIds = new Set(campaigns.map((row) => row.id));
    const aggregates = new Map<string, CampaignAggregate>();
    for (const play of statistics.plays) {
      if (play.campaign_id === null) continue;
      if (!campaignIds.has(play.campaign_id)) continue;
      const estimate = readEstimate(play);
      const count = playCount(play);
      const aggregate = aggregates.get(play.campaign_id) ?? {
        counted: 0,
        estimated: 0,
        estimateMethod: null,
      };
      if (estimate.isEstimate) {
        if (aggregate.counted > 0) throw new CustomerReportSourceError();
        if (
          aggregate.estimateMethod !== null &&
          aggregate.estimateMethod !== estimate.method
        ) {
          throw new CustomerReportSourceError();
        }
        aggregate.estimated += count;
        aggregate.estimateMethod = estimate.method;
      } else {
        if (aggregate.estimated > 0 || aggregate.estimateMethod !== null) {
          throw new CustomerReportSourceError();
        }
        aggregate.counted += count;
      }
      aggregates.set(play.campaign_id, aggregate);
    }

    const completeness = classifyCompleteness(statistics, query.fromMs, query.toMs);
    const dataAsOf = statistics.completeness.data_as_of;

    // Die Qualitaet gilt fuer den gesamten Bericht (CX-049 liefert keine
    // kampagnenscharfe Qualitaet) und wird je Zeile sichtbar wiederholt.

    return campaigns.map((campaign): CustomerReportRow => {
      const aggregate = aggregates.get(campaign.id);
      const isEstimate =
        aggregate !== undefined && aggregate.estimateMethod !== null;
      return {
        customer_id: query.customerId,
        campaign_id: campaign.id,
        campaign_name: campaign.campaign_name ?? "",
        from_utc: query.from,
        to_utc: query.to,
        plays_reported: isEstimate
          ? aggregate.estimated
          : (aggregate?.counted ?? 0),
        measurement: CUSTOMER_REPORT_MEASUREMENT,
        is_estimate: isEstimate,
        estimate_method: isEstimate ? aggregate.estimateMethod! : "",
        completeness,
        data_as_of: dataAsOf,
      };
    });
  }

  /**
   * Loest die Kampagnen des Kunden ueber die vorhandenen CX-032-Tabellen auf.
   * Archivierte Kampagnen bleiben enthalten; der Betreiberkontext entspricht
   * der vorhandenen CX-032-Leseregel. Der Anzeigename ist der Name des
   * zugeordneten Mediums (CX-030); eine eigene Kampagnenbezeichnung existiert
   * im Datenmodell nicht.
   */
  private async resolveCampaigns(
    query: CustomerReportQuery,
    ownerId: string,
  ): Promise<CampaignResolutionRow[]> {
    const result = await this.pool.query<CampaignResolutionRow>(
      [
        "select c.id::text as id, m.display_name as campaign_name",
        "  from campaigns c",
        "  left join media_objects m on m.id = c.media_id",
        " where c.customer_id = $1::uuid",
        "   and c.owner_id = $2",
        "   and ($3::uuid is null or c.id = $3::uuid)",
        " order by c.id asc",
      ].join("\n"),
      [query.customerId, ownerId, query.campaignId],
    );
    return result.rows;
  }
}

export function createCustomerReportService(
  options: CustomerReportServiceOptions,
): CustomerReportService {
  return new CustomerReportService(options);
}

export { StatisticsRowLimitError };
