/**
 * CX-159: Spot-Abspielnachweise und Monatsauswertung.
 *
 * Der Dienst ist die einzige Speichergrenze fuer spot_plays. Eingehende
 * Meldungen werden vollstaendig fachlich geprueft, in genau einer Transaktion
 * geschrieben und je (device_id, play_id) idempotent behandelt. Abweichende
 * Wiederverwendungen derselben play_id sind ein Konflikt und rollen den
 * gesamten Batch zurueck.
 *
 * Die Monatsgrenzen werden ausschliesslich in SQL ueber Europe/Vienna
 * berechnet; die Zuordnung erfolgt nach started_at. Es gibt keine zweite
 * Aggregationstabelle und keine clientseitige Zeitzonenumrechnung.
 */
import type { Pool, PoolClient } from "pg";

/** Batchgrenzen und fachliche Obergrenzen. */
export const SPOT_PLAY_MIN_BATCH_SIZE = 1;
export const SPOT_PLAY_MAX_BATCH_SIZE = 100;
export const SPOT_PLAY_MAX_PLAYED_MS = 3_600_000;
export const SPOT_PLAY_TIME_TOLERANCE_MS = 2_000;

const LOWER_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC_MILLISECOND_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const MONTH_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

const PLAY_KEYS: ReadonlySet<string> = new Set([
  "play_id",
  "campaign_id",
  "media_id",
  "started_at",
  "ended_at",
  "played_ms",
  "completed",
]);

const TAXI_ASSIGNMENT_SQL = [
  "select taxi_id",
  "  from device_taxi_assignments",
  " where device_id = $1::uuid",
  "   and active = true",
  " order by updated_at desc, taxi_id asc",
  " limit 1",
].join("\n");

const INSERT_SQL = [
  "insert into spot_plays",
  "  (device_id, play_id, taxi_id, campaign_id, media_id,",
  "   started_at, ended_at, played_ms, completed, received_at)",
  "values ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid,",
  "        $6::timestamptz, $7::timestamptz, $8, $9, $10::timestamptz)",
  "on conflict (device_id, play_id) do nothing",
  "returning play_id::text as play_id",
].join("\n");

const SELECT_EXISTING_SQL = [
  "select play_id::text as play_id,",
  "       campaign_id::text as campaign_id,",
  "       media_id::text as media_id,",
  "       started_at,",
  "       ended_at,",
  "       played_ms,",
  "       completed",
  "  from spot_plays",
  " where device_id = $1::uuid",
  "   and play_id = any($2::uuid[])",
].join("\n");

const MONTH_FILTER_SQL = [
  "started_at >= ($1::date)::timestamp at time zone 'Europe/Vienna'",
  "and started_at < ($2::date)::timestamp at time zone 'Europe/Vienna'",
].join("\n");

const TOTALS_SQL = [
  "select (count(*) filter (where completed))::int as spots,",
  "       coalesce(sum(played_ms), 0)::int as played_ms,",
  "       count(distinct taxi_id)::int as taxis,",
  "       max(received_at) as last_received_at",
  "  from spot_plays",
  " where " + MONTH_FILTER_SQL,
].join("\n");

const PER_TAXI_SQL = [
  "select p.taxi_id,",
  "       t.display_name,",
  "       (count(*) filter (where p.completed))::int as spots,",
  "       coalesce(sum(p.played_ms), 0)::int as played_ms",
  "  from spot_plays p",
  "  left join taxis t on t.id = p.taxi_id",
  " where p.taxi_id is not null",
  "   and p.started_at >= ($1::date)::timestamp at time zone 'Europe/Vienna'",
  "   and p.started_at < ($2::date)::timestamp at time zone 'Europe/Vienna'",
  " group by p.taxi_id, t.display_name",
  " order by p.taxi_id",
].join("\n");

const PER_MEDIA_SQL = [
  "select p.media_id::text as media_id,",
  "       m.display_name as display_name,",
  "       max(cu.display_name) as customer_name,",
  "       (count(*) filter (where p.completed))::int as spots,",
  "       coalesce(sum(p.played_ms), 0)::int as played_ms",
  "  from spot_plays p",
  "  left join media_objects m on m.id = p.media_id",
  "  left join campaigns c on c.id = p.campaign_id",
  "  left join customers cu on cu.id = c.customer_id",
  " where p.started_at >= ($1::date)::timestamp at time zone 'Europe/Vienna'",
  "   and p.started_at < ($2::date)::timestamp at time zone 'Europe/Vienna'",
  " group by p.media_id, m.display_name",
  " order by p.media_id",
].join("\n");

export class SpotPlayValidationError extends Error {
  constructor(message = "Spot-Meldung ist ungueltig.") {
    super(message);
    this.name = "SpotPlayValidationError";
  }
}

export class SpotPlayConflictError extends Error {
  readonly playId: string;

  constructor(playId: string) {
    super("Spot-Meldung widerspricht dem gespeicherten Nachweis.");
    this.name = "SpotPlayConflictError";
    this.playId = playId;
  }
}

export class SpotPlayStorageError extends Error {
  constructor(message = "Spot-Meldung konnte nicht gespeichert werden.", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SpotPlayStorageError";
  }
}

export interface NormalizedSpotPlay {
  readonly playId: string;
  readonly campaignId: string;
  readonly mediaId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly playedMs: number;
  readonly completed: boolean;
}

export interface SpotPlayIngestResult {
  readonly acceptedPlayIds: string[];
  readonly insertedPlayIds: string[];
  readonly duplicatePlayIds: string[];
}

export interface SpotPlayTotals {
  readonly spots: number;
  readonly played_ms: number;
  readonly taxis: number;
}

export interface SpotPlayPerTaxi {
  readonly taxi_id: string;
  readonly display_name: string | null;
  readonly spots: number;
  readonly played_ms: number;
}

export interface SpotPlayPerMedia {
  readonly media_id: string;
  readonly display_name: string | null;
  readonly customer_name: string | null;
  readonly spots: number;
  readonly played_ms: number;
}

export interface MonthlySpotPlaySummary {
  readonly month: string;
  readonly totals: SpotPlayTotals;
  readonly per_taxi: SpotPlayPerTaxi[];
  readonly per_media: SpotPlayPerMedia[];
  readonly last_received_at: string | null;
}

interface TotalsRow extends Record<string, unknown> {
  spots: number;
  played_ms: number;
  taxis: number;
  last_received_at: Date | string | null;
}

interface PerTaxiRow extends Record<string, unknown> {
  taxi_id: string;
  display_name: string | null;
  spots: number;
  played_ms: number;
}

interface PerMediaRow extends Record<string, unknown> {
  media_id: string;
  display_name: string | null;
  customer_name: string | null;
  spots: number;
  played_ms: number;
}

interface ExistingRow extends Record<string, unknown> {
  play_id: string;
  campaign_id: string;
  media_id: string;
  started_at: Date | string;
  ended_at: Date | string;
  played_ms: number;
  completed: boolean;
}

export interface SpotPlayServiceOptions {
  readonly pool: Pool;
  /** Injizierbare Serveruhr; ohne Angabe gilt die reale Uhr. */
  readonly now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeUuid(value: unknown): string {
  if (typeof value !== "string" || !LOWER_UUID_PATTERN.test(value)) {
    throw new SpotPlayValidationError();
  }
  return value;
}

function normalizeDeviceId(value: unknown): string {
  return normalizeUuid(value);
}

function normalizeTimestamp(value: unknown): { iso: string; ms: number } {
  if (typeof value !== "string" || !UTC_MILLISECOND_PATTERN.test(value)) {
    throw new SpotPlayValidationError();
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new SpotPlayValidationError();
  }
  return { iso: value, ms };
}

/** Fachliche Pruefung des gesamten Batches; es wird noch nichts geschrieben. */
export function normalizeSpotPlayBatch(plays: unknown): NormalizedSpotPlay[] {
  if (
    !Array.isArray(plays) ||
    plays.length < SPOT_PLAY_MIN_BATCH_SIZE ||
    plays.length > SPOT_PLAY_MAX_BATCH_SIZE
  ) {
    throw new SpotPlayValidationError();
  }

  const seen = new Set<string>();
  const normalized: NormalizedSpotPlay[] = [];
  for (const raw of plays) {
    if (!isRecord(raw)) {
      throw new SpotPlayValidationError();
    }
    for (const key of Object.keys(raw)) {
      if (!PLAY_KEYS.has(key)) {
        throw new SpotPlayValidationError();
      }
    }

    const playId = normalizeUuid(raw.play_id);
    const campaignId = normalizeUuid(raw.campaign_id);
    const mediaId = normalizeUuid(raw.media_id);
    const started = normalizeTimestamp(raw.started_at);
    const ended = normalizeTimestamp(raw.ended_at);
    if (ended.ms < started.ms) {
      throw new SpotPlayValidationError();
    }

    const playedMs = raw.played_ms;
    if (
      typeof playedMs !== "number" ||
      !Number.isInteger(playedMs) ||
      playedMs < 0 ||
      playedMs > SPOT_PLAY_MAX_PLAYED_MS
    ) {
      throw new SpotPlayValidationError();
    }
    if (playedMs > ended.ms - started.ms + SPOT_PLAY_TIME_TOLERANCE_MS) {
      throw new SpotPlayValidationError();
    }
    if (typeof raw.completed !== "boolean") {
      throw new SpotPlayValidationError();
    }
    if (seen.has(playId)) {
      throw new SpotPlayValidationError();
    }
    seen.add(playId);

    normalized.push({
      playId,
      campaignId,
      mediaId,
      startedAt: started.iso,
      endedAt: ended.iso,
      playedMs,
      completed: raw.completed,
    });
  }
  return normalized;
}

export function parseMonth(month: unknown): string {
  if (typeof month !== "string" || !MONTH_PATTERN.test(month)) {
    throw new SpotPlayValidationError();
  }
  return month;
}

function nextMonthDate(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  if (monthNumber === 12) {
    return String(year + 1).padStart(4, "0") + "-01-01";
  }
  return (
    String(year).padStart(4, "0") +
    "-" +
    String(monthNumber + 1).padStart(2, "0") +
    "-01"
  );
}

function storedTimeMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function sameContent(play: NormalizedSpotPlay, row: ExistingRow): boolean {
  return (
    row.campaign_id.toLowerCase() === play.campaignId &&
    row.media_id.toLowerCase() === play.mediaId &&
    storedTimeMs(row.started_at) === Date.parse(play.startedAt) &&
    storedTimeMs(row.ended_at) === Date.parse(play.endedAt) &&
    row.played_ms === play.playedMs &&
    row.completed === play.completed
  );
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Einziger Schreib-/Leseadapter der Spot-Nachweise. Der Pool wird nur fuer die
 * Dauer einer Transaktion ausgeliehen; es gibt keinen modulweiten Zustand.
 */
export class SpotPlayService {
  private readonly pool: Pool;
  private readonly now: () => Date;

  constructor(options: SpotPlayServiceOptions) {
    this.pool = options.pool;
    this.now = options.now ?? (() => new Date());
  }

  async ingest(deviceId: string, plays: unknown): Promise<SpotPlayIngestResult> {
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    const batch = normalizeSpotPlayBatch(plays);
    const receivedAt = this.now();
    if (!(receivedAt instanceof Date) || Number.isNaN(receivedAt.getTime())) {
      throw new SpotPlayStorageError("Die injizierte Serveruhr liefert keinen gueltigen Zeitpunkt.");
    }

    const ordered = [...batch].sort((left, right) =>
      left.playId.localeCompare(right.playId),
    );

    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw new SpotPlayStorageError(undefined, { cause: error });
    }

    let inTransaction = false;
    try {
      await client.query("begin");
      inTransaction = true;

      const assignment = await client.query<{ taxi_id: string }>(
        TAXI_ASSIGNMENT_SQL,
        [normalizedDeviceId],
      );
      const taxiId = assignment.rows[0]?.taxi_id ?? null;

      const insertedPlayIds: string[] = [];
      const possiblyExisting: NormalizedSpotPlay[] = [];
      for (const play of ordered) {
        const result = await client.query<{ play_id: string }>(INSERT_SQL, [
          normalizedDeviceId,
          play.playId,
          taxiId,
          play.campaignId,
          play.mediaId,
          play.startedAt,
          play.endedAt,
          play.playedMs,
          play.completed,
          receivedAt.toISOString(),
        ]);
        if (result.rows.length === 0) {
          possiblyExisting.push(play);
        } else {
          insertedPlayIds.push(play.playId);
        }
      }

      if (possiblyExisting.length > 0) {
        const existing = await client.query<ExistingRow>(SELECT_EXISTING_SQL, [
          normalizedDeviceId,
          possiblyExisting.map((play) => play.playId),
        ]);
        const byPlayId = new Map<string, ExistingRow>();
        for (const row of existing.rows) {
          byPlayId.set(row.play_id.toLowerCase(), row);
        }
        for (const play of possiblyExisting) {
          const row = byPlayId.get(play.playId);
          if (row === undefined) {
            throw new SpotPlayStorageError(
              "Bereits konfliktfreier Nachweis ist nicht lesbar: " + play.playId,
            );
          }
          if (!sameContent(play, row)) {
            throw new SpotPlayConflictError(play.playId);
          }
        }
      }

      await client.query("commit");
      inTransaction = false;

      const insertedSet = new Set(insertedPlayIds);
      const acceptedPlayIds = batch.map((play) => play.playId);
      return {
        acceptedPlayIds,
        insertedPlayIds: acceptedPlayIds.filter((playId) => insertedSet.has(playId)),
        duplicatePlayIds: acceptedPlayIds.filter((playId) => !insertedSet.has(playId)),
      };
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query("rollback");
        } catch {
          // Der urspruengliche Fehler bleibt massgeblich.
        }
      }
      if (
        error instanceof SpotPlayConflictError ||
        error instanceof SpotPlayStorageError
      ) {
        throw error;
      }
      throw new SpotPlayStorageError(undefined, { cause: error });
    } finally {
      client.release();
    }
  }

  async monthlySummary(month: string): Promise<MonthlySpotPlaySummary> {
    const normalizedMonth = parseMonth(month);
    const startDate = normalizedMonth + "-01";
    const endDate = nextMonthDate(normalizedMonth);
    const parameters = [startDate, endDate];

    const totalsResult = await this.pool.query<TotalsRow>(TOTALS_SQL, parameters);
    const totalsRow = totalsResult.rows[0];
    const totals: SpotPlayTotals = {
      spots: totalsRow?.spots ?? 0,
      played_ms: totalsRow?.played_ms ?? 0,
      taxis: totalsRow?.taxis ?? 0,
    };

    const perTaxiResult = await this.pool.query<PerTaxiRow>(
      PER_TAXI_SQL,
      parameters,
    );
    const perTaxi = perTaxiResult.rows.map((row) => ({
      taxi_id: row.taxi_id,
      display_name: row.display_name,
      spots: row.spots,
      played_ms: row.played_ms,
    }));

    const perMediaResult = await this.pool.query<PerMediaRow>(
      PER_MEDIA_SQL,
      parameters,
    );
    const perMedia = perMediaResult.rows.map((row) => ({
      media_id: row.media_id,
      display_name: row.display_name,
      customer_name: row.customer_name,
      spots: row.spots,
      played_ms: row.played_ms,
    }));

    return {
      month: normalizedMonth,
      totals,
      per_taxi: perTaxi,
      per_media: perMedia,
      last_received_at: isoOrNull(totalsRow?.last_received_at ?? null),
    };
  }
}

export function createSpotPlayService(
  options: SpotPlayServiceOptions,
): SpotPlayService {
  return new SpotPlayService(options);
}
