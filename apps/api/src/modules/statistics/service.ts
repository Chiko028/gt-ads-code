/**
 * CX-049 / R-404: kleiner, lesender Statistikdienst.
 *
 * Quellen und Grenzen:
 * - Ein vollstaendiger Play ist ein gemeldeter Wiedergabeabschnitt, der mit
 *   einer playing-Beobachtung beginnt und mit der naechsten stopped-
 *   Beobachtung desselben Geraets endet. Reine Starts, Abbrueche (unknown)
 *   und fehlende Enden zaehlen nicht.
 * - Die Kampagne wird nur bei eindeutiger, zum Startzeitpunkt aktiver
 *   Kundenkampagne mit Taxi-Ziel zugeordnet; sonst bleibt sie null. Der
 *   GT-Ads-Fallback ist keine Kundenkampagne und wird nie gezaehlt.
 * - Die Taxi-ID kommt ausschliesslich aus gespeicherter historischer
 *   Zuordnung; die heutige Zuordnung ersetzt keine fehlende Evidenz.
 * - Verfuegbarkeit stammt aus vorhandenen Tagesrollups mit belegtem Nenner
 *   (Beobachtungsabdeckung). Ohne Nenner bleibt sie null.
 * - Sync-Fehler sind deduplizierte technische Fehlerereignisse mit
 *   sync-Fehlercode. Sie haengen nicht vom Kampagnenfilter ab.
 *
 * Es gibt keine neue Speicherung, keine Migration und keine parallele
 * Aggregationspipeline. Rollups werden nur fuer die Geraeteverfuegbarkeit
 * gelesen; Wiedergabezeilen kommen aus den vorhandenen Rohereignissen, weil
 * eine passende Rollup-Dimension fuer Kampagne/Taxi nicht existiert.
 */
import type { Pool } from "pg";
import {
  STATISTICS_ROW_LIMIT,
  SYNC_ERROR_CODE_PREFIX,
  type DeviceQualityRow,
  type MeasurementDefinition,
  type MissingDay,
  type PlayRow,
  type StatisticsCompleteness,
  type StatisticsQuery,
  type StatisticsResponse,
  type StatisticsServiceOptions,
} from "./types.js";

/** Ergebniszeilen ueberschreiten die harte Obergrenze. */
export class StatisticsRowLimitError extends Error {
  constructor() {
    super("Die Statistik ueberschreitet die zulaessige Zeilenobergrenze.");
    this.name = "StatisticsRowLimitError";
  }
}

interface ObservationRow {
  device_id: string;
  event_id: string;
  occurred_at: Date | string;
  vehicle_ready: boolean | null;
  paused: boolean | null;
  playback: string;
  technical_fault: boolean | null;
  received_at: Date | string;
}

interface AssignmentRow {
  device_id: string;
  taxi_id: string;
  active: boolean;
  updated_at: Date | string;
}

interface CampaignRow {
  id: string;
  start_at: Date | string;
  end_at: Date | string;
  taxi_id: string;
}

interface RollupRow {
  device_id: string;
  local_date: string;
  day_start: Date | string;
  day_end: Date | string;
  revision: number;
  evaluation_time: Date | string;
  classes: unknown;
  coverage: unknown;
}

interface AlarmRow {
  episode_id: number;
  resource_id: string;
  error_code: string;
  fault_started_at: Date | string;
}

interface CompletedPlay {
  deviceId: string;
  campaignId: string | null;
  taxiId: string | null;
  startedAtMs: number;
  completedAtMs: number;
}

const DAY_MS = 86_400_000;
const FALLBACK_CAMPAIGN_ID = "gt-ads-fallback";
const MAX_PLAUSIBLE_PLAY_MS = 31 * DAY_MS;

function toMs(value: Date | string): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error("Gespeicherter Zeitpunkt ist ungueltig.");
  }
  return ms;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function parseClasses(value: unknown): Record<string, number> {
  const source = isRecord(value) ? value : {};
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(source)) {
    const parsed = finiteNonNegative(entry);
    if (parsed !== null) result[key] = parsed;
  }
  return result;
}

function parseCoverage(value: unknown): { coveredMs: number; ratio: number | null } {
  const source = isRecord(value) ? value : {};
  const covered = finiteNonNegative(source.coveredMs);
  const ratio = typeof source.ratio === "number" && Number.isFinite(source.ratio)
    ? source.ratio
    : null;
  return { coveredMs: covered ?? 0, ratio };
}

function compareNullableStrings(
  left: string | null,
  right: string | null,
): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
}

function cleanObservation(row: ObservationRow): boolean {
  return (
    row.vehicle_ready !== false &&
    row.paused !== true &&
    row.technical_fault !== true
  );
}

async function tableExists(pool: Pool, name: string): Promise<boolean> {
  const result = await pool.query<{ exists: string | null }>(
    "select to_regclass($1)::text as exists",
    [name],
  );
  return result.rows[0]?.exists !== null && result.rows[0]?.exists !== undefined;
}

export class StatisticsService {
  private readonly pool: Pool;
  private readonly now: () => Date;

  constructor(options: StatisticsServiceOptions) {
    this.pool = options.pool;
    this.now = options.now ?? (() => new Date());
  }

  async getStatistics(query: StatisticsQuery): Promise<StatisticsResponse> {
    const candidateDevices = await this.loadCandidateDevices(query);
    const [
      assignments,
      campaigns,
      observations,
      rollups,
      syncErrors,
      campaignSourceAvailable,
      assignmentSourceAvailable,
    ] = await Promise.all([
      this.loadAssignments(candidateDevices),
      this.loadCampaigns(query),
      this.loadObservations(candidateDevices, query),
      this.loadRollups(candidateDevices, query),
      this.loadSyncErrors(candidateDevices, query),
      tableExists(this.pool, "campaigns").then(async (campaignsTable) =>
        campaignsTable
          ? tableExists(this.pool, "campaign_targets")
          : false,
      ),
      tableExists(this.pool, "device_taxi_assignments"),
    ]);

    const assignmentsByDevice = new Map<string, AssignmentRow[]>();
    for (const row of assignments) {
      const list = assignmentsByDevice.get(row.device_id) ?? [];
      list.push(row);
      assignmentsByDevice.set(row.device_id, list);
    }

    const resolveTaxi = (deviceId: string, atMs: number): string | null => {
      const rows = assignmentsByDevice.get(deviceId) ?? [];
      const candidates = new Map<string, number>();
      for (const row of rows) {
        const updatedMs = toMs(row.updated_at);
        if (row.active && updatedMs <= atMs) {
          const distance = atMs - updatedMs;
          const current = candidates.get(row.taxi_id);
          if (current === undefined || distance < current) {
            candidates.set(row.taxi_id, distance);
          }
        } else if (!row.active && updatedMs > atMs) {
          const distance = updatedMs - atMs;
          const current = candidates.get(row.taxi_id);
          if (current === undefined || distance < current) {
            candidates.set(row.taxi_id, distance);
          }
        }
      }
      return candidates.size === 1 ? [...candidates.keys()][0]! : null;
    };

    const campaignsByTaxi = new Map<string, CampaignRow[]>();
    for (const row of campaigns) {
      const list = campaignsByTaxi.get(row.taxi_id) ?? [];
      list.push(row);
      campaignsByTaxi.set(row.taxi_id, list);
    }

    const resolveCampaign = (
      taxiId: string | null,
      atMs: number,
    ): string | null => {
      if (taxiId === null) return null;
      const matching = new Set<string>();
      for (const row of campaignsByTaxi.get(taxiId) ?? []) {
        if (row.id === FALLBACK_CAMPAIGN_ID) continue;
        if (toMs(row.start_at) <= atMs && atMs < toMs(row.end_at)) {
          matching.add(row.id);
        }
      }
      return matching.size === 1 ? [...matching][0]! : null;
    };

    const { plays, unattributedPlays } = this.buildPlays(
      observations,
      query,
      resolveTaxi,
      resolveCampaign,
    );

    const quality = this.buildQuality(
      candidateDevices,
      query,
      rollups,
      resolveTaxi,
      syncErrors,
    );

    if (plays.length + quality.length > STATISTICS_ROW_LIMIT) {
      throw new StatisticsRowLimitError();
    }

    const completeness = this.buildCompleteness(
      query,
      candidateDevices,
      observations,
      rollups,
      assignmentSourceAvailable,
      campaignSourceAvailable,
      unattributedPlays,
    );

    const definition: MeasurementDefinition = {
      interval: "[from,to)",
      play_count:
        "abgeschlossener gemeldeter Wiedergabeabschnitt: playing-Beobachtung, danach naechste stopped-Beobachtung desselben Geraets",
      campaign_attribution:
        "eindeutige, zum Startzeitpunkt aktive Kundenkampagne mit Taxi-Ziel; sonst null",
      taxi_attribution:
        "gespeicherte historische Geraete-Taxi-Zuordnung; heutige Zuordnung ersetzt keine fehlende Evidenz",
      availability:
        "1 minus technische Fehlerdauer geteilt durch belegte Beobachtungsdauer aus Tagesrollups; null ohne belastbaren Nenner",
      sync_errors:
        "deduplizierte technische Fehlerereignisse mit sync-Fehlercode im Geraete-/Zeitbereich, unabhaengig vom Kampagnenfilter",
      excludes: [
        "reine Starts ohne gemeldetes Ende",
        "Abbrueche und unknown-Zustaende",
        "GT-Ads-Fallback ohne Kundenkampagne",
        "Fahrgastkontakt oder aktuelle Erreichbarkeit",
      ],
    };

    const response: StatisticsResponse = {
      from: query.from,
      to: query.to,
      generated_at: this.now().toISOString(),
      filters: {
        campaign_id: query.campaignId,
        device_id: query.deviceId,
        taxi_id: query.taxiId,
      },
      definition,
      completeness,
      row_limit: STATISTICS_ROW_LIMIT,
      row_count: plays.length + quality.length,
      quality_scope: "device_taxi_time",
      plays,
      device_quality: quality,
    };
    return response;
  }

  private async loadCandidateDevices(query: StatisticsQuery): Promise<string[]> {
    if (query.deviceId !== null) return [query.deviceId];

    const params: unknown[] = [
      query.from,
      query.to,
      toIso(query.fromMs - MAX_PLAUSIBLE_PLAY_MS),
    ];
    const parts = [
      [
        "select device_id::text as device_id",
        "  from telemetry_observations",
        " where occurred_at >= $3::timestamptz",
        "   and occurred_at < $2::timestamptz",
      ].join("\n"),
      [
        "select device_id::text as device_id",
        "  from telemetry_daily_rollups",
        " where day_end > $1::timestamptz",
        "   and day_start < $2::timestamptz",
      ].join("\n"),
    ];

    if (query.taxiId !== null && (await tableExists(this.pool, "device_taxi_assignments"))) {
      params.push(query.taxiId);
      parts.push(
        [
          "select device_id::text as device_id",
          "  from device_taxi_assignments",
          " where taxi_id = $4",
        ].join("\n"),
      );
    }

    const result = await this.pool.query<{ device_id: string }>(
      "select distinct device_id from (" + parts.join("\nunion\n") + ") candidates order by device_id asc",
      params,
    );
    return result.rows.map((row) => row.device_id);
  }

  private async loadObservations(
    deviceIds: string[],
    query: StatisticsQuery,
  ): Promise<ObservationRow[]> {
    if (deviceIds.length === 0) return [];
    const result = await this.pool.query<ObservationRow>(
      [
        "select device_id::text as device_id, event_id::text as event_id,",
        "       occurred_at, vehicle_ready, paused, playback, technical_fault, received_at",
        "  from telemetry_observations",
        " where device_id = any($1::uuid[])",
        "   and occurred_at >= $2::timestamptz",
        "   and occurred_at < $3::timestamptz",
        " order by device_id asc, occurred_at asc, event_id asc",
      ].join("\n"),
      [deviceIds, toIso(query.fromMs - MAX_PLAUSIBLE_PLAY_MS), query.to],
    );
    return result.rows;
  }

  private async loadAssignments(deviceIds: string[]): Promise<AssignmentRow[]> {
    if (deviceIds.length === 0) return [];
    if (!(await tableExists(this.pool, "device_taxi_assignments"))) return [];
    const result = await this.pool.query<AssignmentRow>(
      [
        "select device_id::text as device_id, taxi_id, active, updated_at",
        "  from device_taxi_assignments",
        " where device_id = any($1::uuid[])",
        " order by device_id asc, updated_at asc, taxi_id asc",
      ].join("\n"),
      [deviceIds],
    );
    return result.rows;
  }

  private async loadCampaigns(query: StatisticsQuery): Promise<CampaignRow[]> {
    if (
      !(await tableExists(this.pool, "campaigns")) ||
      !(await tableExists(this.pool, "campaign_targets"))
    ) {
      return [];
    }
    const result = await this.pool.query<CampaignRow>(
      [
        "select c.id::text as id, c.start_at, c.end_at, ct.target_id as taxi_id",
        "  from campaigns c",
        "  join campaign_targets ct on ct.campaign_id = c.id",
        " where ct.kind = 'taxi'",
        "   and c.status = 'active'",
        "   and c.end_at > $1::timestamptz",
        "   and c.start_at < $2::timestamptz",
        " order by c.id asc, ct.target_id asc",
      ].join("\n"),
      [toIso(query.fromMs - MAX_PLAUSIBLE_PLAY_MS), query.to],
    );
    return result.rows;
  }

  private async loadRollups(
    deviceIds: string[],
    query: StatisticsQuery,
  ): Promise<RollupRow[]> {
    if (deviceIds.length === 0) return [];
    const result = await this.pool.query<RollupRow>(
      [
        "select distinct on (device_id, local_date, time_zone, policy_version, algorithm_version)",
        "       device_id::text as device_id, local_date::text as local_date,",
        "       day_start, day_end, revision, evaluation_time, classes, coverage",
        "  from telemetry_daily_rollups",
        " where device_id = any($1::uuid[])",
        "   and day_end > $2::timestamptz",
        "   and day_start < $3::timestamptz",
        " order by device_id, local_date, time_zone, policy_version, algorithm_version,",
        "          evaluation_time desc, revision desc",
      ].join("\n"),
      [deviceIds, query.from, query.to],
    );
    return result.rows;
  }

  private async loadSyncErrors(
    deviceIds: string[],
    query: StatisticsQuery,
  ): Promise<AlarmRow[]> {
    if (deviceIds.length === 0) return [];
    if (!(await tableExists(this.pool, "technical_alarm_episodes"))) return [];
    const result = await this.pool.query<AlarmRow>(
      [
        "select episode_id, resource_id, error_code, fault_started_at",
        "  from technical_alarm_episodes",
        " where fault_started_at >= $1::timestamptz",
        "   and fault_started_at < $2::timestamptz",
        "   and lower(error_code) like $3",
        " order by episode_id asc",
      ].join("\n"),
      [query.from, query.to, SYNC_ERROR_CODE_PREFIX + "%"],
    );
    return result.rows;
  }

  private buildPlays(
    observations: ObservationRow[],
    query: StatisticsQuery,
    resolveTaxi: (deviceId: string, atMs: number) => string | null,
    resolveCampaign: (taxiId: string | null, atMs: number) => string | null,
  ): { plays: PlayRow[]; unattributedPlays: number } {
    const byDevice = new Map<string, ObservationRow[]>();
    for (const row of observations) {
      const list = byDevice.get(row.device_id) ?? [];
      list.push(row);
      byDevice.set(row.device_id, list);
    }

    const completed: CompletedPlay[] = [];
    for (const [deviceId, rows] of byDevice) {
      let openStartMs: number | null = null;
      const seen = new Set<string>();
      for (const row of rows) {
        if (seen.has(row.event_id)) continue;
        seen.add(row.event_id);
        const atMs = toMs(row.occurred_at);
        if (row.playback === "playing") {
          openStartMs = cleanObservation(row) ? atMs : null;
          continue;
        }
        if (row.playback === "stopped") {
          if (
            openStartMs !== null &&
            cleanObservation(row) &&
            atMs > openStartMs &&
            atMs - openStartMs <= MAX_PLAUSIBLE_PLAY_MS
          ) {
            const taxiId = resolveTaxi(deviceId, openStartMs);
            completed.push({
              deviceId,
              campaignId: resolveCampaign(taxiId, openStartMs),
              taxiId,
              startedAtMs: openStartMs,
              completedAtMs: atMs,
            });
          }
          openStartMs = null;
          continue;
        }
        // unknown/ungueltig beendet den offenen Abschnitt ohne Play.
        openStartMs = null;
      }
    }

    // Ein abgeschlossener Abschnitt ohne eindeutige Kundenkampagne ist kein
    // Kunden-Play (z. B. GT-Ads-Fallback) und wird nicht gezaehlt; die
    // Unvollstaendigkeit der Attribution bleibt sichtbar.
    const inRange = completed.filter(
      (play) =>
        play.completedAtMs >= query.fromMs && play.completedAtMs < query.toMs,
    );
    const unattributedPlays = inRange.filter(
      (play) => play.campaignId === null,
    ).length;
    const filtered = inRange.filter((play) => {
      if (play.campaignId === null) return false;
      if (query.campaignId !== null && play.campaignId !== query.campaignId) {
        return false;
      }
      if (query.taxiId !== null && play.taxiId !== query.taxiId) return false;
      return true;
    });

    const grouped = new Map<string, PlayRow>();
    for (const play of filtered) {
      const key =
        (play.campaignId ?? "\u0000") +
        "|" +
        play.deviceId +
        "|" +
        (play.taxiId ?? "\u0000");
      const existing = grouped.get(key);
      if (existing === undefined) {
        grouped.set(key, {
          campaign_id: play.campaignId,
          device_id: play.deviceId,
          taxi_id: play.taxiId,
          play_count: 1,
          first_played_at: toIso(play.completedAtMs),
          last_played_at: toIso(play.completedAtMs),
        });
      } else {
        existing.play_count += 1;
        if (play.completedAtMs < Date.parse(existing.first_played_at)) {
          existing.first_played_at = toIso(play.completedAtMs);
        }
        if (play.completedAtMs > Date.parse(existing.last_played_at)) {
          existing.last_played_at = toIso(play.completedAtMs);
        }
      }
    }

    const plays = [...grouped.values()].sort((left, right) => {
      const campaign = compareNullableStrings(left.campaign_id, right.campaign_id);
      if (campaign !== 0) return campaign;
      const device = left.device_id < right.device_id ? -1 : left.device_id > right.device_id ? 1 : 0;
      if (device !== 0) return device;
      return compareNullableStrings(left.taxi_id, right.taxi_id);
    });
    return { plays, unattributedPlays };
  }

  private buildQuality(
    deviceIds: string[],
    query: StatisticsQuery,
    rollups: RollupRow[],
    resolveTaxi: (deviceId: string, atMs: number) => string | null,
    syncErrors: AlarmRow[],
  ): DeviceQualityRow[] {
    const rollupsByDevice = new Map<string, RollupRow[]>();
    for (const row of rollups) {
      const list = rollupsByDevice.get(row.device_id) ?? [];
      list.push(row);
      rollupsByDevice.set(row.device_id, list);
    }

    const syncByDevice = new Map<string, number>();
    const deviceSet = new Set(deviceIds);
    const taxiToDevices = new Map<string, string[]>();
    for (const deviceId of [...deviceIds].sort()) {
      const taxiId = resolveTaxi(deviceId, query.fromMs);
      if (taxiId === null) continue;
      const list = taxiToDevices.get(taxiId) ?? [];
      list.push(deviceId);
      taxiToDevices.set(taxiId, list);
    }
    for (const row of syncErrors) {
      // Geraetebezogene Fehler zaehlen genau einmal. Taxiweite Fehler werden
      // genau einem deterministischen Geraet des Taxis zugerechnet, niemals
      // je Kampagne oder je Tablet vervielfacht.
      const target = deviceSet.has(row.resource_id)
        ? row.resource_id
        : taxiToDevices.get(row.resource_id)?.[0];
      if (target === undefined) continue;
      syncByDevice.set(target, (syncByDevice.get(target) ?? 0) + 1);
    }

    return deviceIds
      .map((deviceId): DeviceQualityRow => {
        let observedMs = 0;
        let faultMs = 0;
        let fullDayRows = 0;
        let partialOnly = false;
        for (const row of rollupsByDevice.get(deviceId) ?? []) {
          const dayStartMs = toMs(row.day_start);
          const dayEndMs = toMs(row.day_end);
          if (dayStartMs < query.fromMs || dayEndMs > query.toMs) {
            partialOnly = true;
            continue;
          }
          const coverage = parseCoverage(row.coverage);
          const classes = parseClasses(row.classes);
          observedMs += coverage.coveredMs;
          faultMs += classes.technical_fault ?? 0;
          fullDayRows += 1;
        }

        let availability: number | null = null;
        let reason: string | null = null;
        if (fullDayRows === 0) {
          reason = partialOnly
            ? "day_not_fully_covered"
            : "no_rollup_for_complete_day";
        } else if (observedMs <= 0) {
          reason = "no_reliable_denominator";
        } else {
          availability = Math.max(
            0,
            Math.min(1, 1 - faultMs / observedMs),
          );
        }

        return {
          device_id: deviceId,
          taxi_id: resolveTaxi(deviceId, query.fromMs),
          availability_ratio:
            availability === null ? null : Math.round(availability * 1_000_000) / 1_000_000,
          availability_reason: reason,
          observed_ms: fullDayRows === 0 ? null : observedMs,
          technical_fault_ms: fullDayRows === 0 ? null : faultMs,
          sync_errors: syncByDevice.get(deviceId) ?? 0,
          sync_error_scope: "device_or_taxi_time",
        };
      })
      .sort((left, right) =>
        left.device_id < right.device_id ? -1 : left.device_id > right.device_id ? 1 : 0,
      );
  }

  private buildCompleteness(
    query: StatisticsQuery,
    deviceIds: string[],
    observations: ObservationRow[],
    rollups: RollupRow[],
    assignmentSourceAvailable: boolean,
    campaignSourceAvailable: boolean,
    unattributedPlays: number,
  ): StatisticsCompleteness {
    const reasons = new Set<string>();
    const missingDays: MissingDay[] = [];
    const observationDays = new Set<string>();
    for (const row of observations) {
      observationDays.add(toIso(toMs(row.occurred_at)).slice(0, 10));
    }
    const rollupDays = new Set<string>();
    for (const row of rollups) {
      rollupDays.add(row.local_date);
    }

    const firstDay = Math.floor(query.fromMs / DAY_MS) * DAY_MS;
    for (let cursor = firstDay; cursor < query.toMs; cursor += DAY_MS) {
      const day = toIso(cursor).slice(0, 10);
      const hasRaw = observationDays.has(day);
      const hasRollup = rollupDays.has(day);
      if (!hasRaw && hasRollup) {
        missingDays.push({ day, reason: "raw_retention_gap" });
      } else if (!hasRaw && !hasRollup) {
        missingDays.push({ day, reason: "no_raw_evidence" });
      }
    }
    if (observations.length === 0 && rollups.length === 0) {
      reasons.add("missing_raw_evidence");
    }
    if (missingDays.some((entry) => entry.reason === "raw_retention_gap")) {
      reasons.add("raw_retention_gap");
    }
    if (missingDays.some((entry) => entry.reason === "no_raw_evidence")) {
      reasons.add("missing_raw_evidence");
    }

    let coverageIncomplete = false;
    for (const row of rollups) {
      const coverage = parseCoverage(row.coverage);
      if (coverage.ratio !== null && coverage.ratio < 1) {
        coverageIncomplete = true;
      }
    }
    if (coverageIncomplete) reasons.add("observation_coverage_incomplete");
    if (!assignmentSourceAvailable) reasons.add("taxi_history_unavailable");
    if (!campaignSourceAvailable) reasons.add("campaign_source_unavailable");
    if (unattributedPlays > 0) reasons.add("campaign_attribution_incomplete");

    let dataAsOfMs = 0;
    for (const row of observations) {
      dataAsOfMs = Math.max(dataAsOfMs, toMs(row.received_at));
    }
    for (const row of rollups) {
      dataAsOfMs = Math.max(dataAsOfMs, toMs(row.evaluation_time));
    }
    if (dataAsOfMs === 0) {
      dataAsOfMs = this.now().getTime();
    }

    return {
      status:
        missingDays.length === 0 && reasons.size === 0
          ? "complete"
          : "incomplete",
      reasons: [...reasons].sort(),
      data_as_of: toIso(dataAsOfMs),
      missing_days: missingDays.sort((left, right) =>
        left.day < right.day ? -1 : left.day > right.day ? 1 : 0,
      ),
    };
  }
}

/** Fabrik fuer den lesenden Dienst; erwartet einen vorhandenen pg-Pool. */
export function createStatisticsService(
  options: StatisticsServiceOptions,
): StatisticsService {
  return new StatisticsService(options);
}

