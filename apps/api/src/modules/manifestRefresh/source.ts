/**
 * CX-041 / R-301: konsistente Quellen fuer einen Manifest-Lauf.
 *
 * Gelesen werden ausschliesslich persistierte Kampagnen-, Ziel- und
 * Medienmetadaten. Die Abfrage laeuft im selben REPEATABLE-READ-Snapshot wie
 * die Zustandspruefung des Taxis. Es werden keine Belegungen, Hashes oder
 * Laufzeiten neu erfunden.
 */
import type { SqlQueryable } from "../audit/repository.js";
import {
  TAXI_GROUP_MEMBERSHIPS_TABLE,
  relationExists,
} from "./marking.js";

export interface SourceCampaign {
  id: string;
  mediaId: string;
  startAt: string;
  endAt: string;
  taxiIds: string[];
  groupIds: string[];
  sha256: string;
  sizeBytes: number;
  durationMs: number;
}

export interface TaxiManifestSource {
  taxiId: string;
  groupIds: string[];
  campaigns: SourceCampaign[];
}

interface SourceRow {
  id: string;
  media_id: string;
  start_at: Date | string;
  end_at: Date | string;
  sha256: string | null;
  size_bytes: string | number | null;
  duration_seconds: string | number | null;
  taxi_ids: string[] | null;
  group_ids: string[] | null;
}

function isoString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(value).toISOString();
}

export async function loadTaxiGroupIds(
  executor: SqlQueryable,
  taxiId: string,
): Promise<string[]> {
  if (!(await relationExists(executor, TAXI_GROUP_MEMBERSHIPS_TABLE))) {
    return [];
  }

  const result = await executor.query<{ group_id: string }>(
    [
      "select group_id",
      "  from taxi_group_memberships",
      " where taxi_id = $1",
      " order by group_id asc",
    ].join("\n"),
    [taxiId],
  );
  return result.rows.map((row) => row.group_id);
}

/**
 * Liest alle aktiven, nicht archivierten Kampagnen, die das Taxi direkt oder
 * ueber eine seiner Gruppen adressieren und deren Laufzeitfenster den
 * injizierten Auswertungszeitpunkt enthaelt. Die Reihenfolge ist deterministisch.
 */
export async function loadTaxiManifestSource(
  executor: SqlQueryable,
  taxiId: string,
  evaluatedAt: Date,
): Promise<TaxiManifestSource> {
  const groupIds = await loadTaxiGroupIds(executor, taxiId);

  const result = await executor.query<SourceRow>(
    [
      "select",
      "  c.id::text as id,",
      "  c.media_id::text as media_id,",
      "  c.start_at, c.end_at,",
      "  m.sha256, m.size_bytes, m.duration_seconds,",
      "  coalesce((",
      "    select array_agg(target_id order by target_id)",
      "      from campaign_targets",
      "     where campaign_id = c.id and kind = 'taxi'",
      "  ), '{}'::text[]) as taxi_ids,",
      "  coalesce((",
      "    select array_agg(target_id order by target_id)",
      "      from campaign_targets",
      "     where campaign_id = c.id and kind = 'group'",
      "  ), '{}'::text[]) as group_ids",
      "  from campaigns c",
      "  join media_objects m on m.id = c.media_id",
      " where c.status = 'active'",
      "   and m.status = 'ready'",
      "   and c.archived = false",
      "   and c.start_at <= $2",
      "   and c.end_at > $2",
      "   and (",
      "     exists (",
      "       select 1 from campaign_targets t",
      "        where t.campaign_id = c.id",
      "          and t.kind = 'taxi'",
      "          and t.target_id = $1",
      "     )",
      "     or exists (",
      "       select 1",
      "         from campaign_targets t",
      "         join taxi_group_memberships gm on gm.group_id = t.target_id",
      "        where t.campaign_id = c.id",
      "          and t.kind = 'group'",
      "          and gm.taxi_id = $1",
      "     )",
      "   )",
      " order by c.id asc",
    ].join("\n"),
    [taxiId, evaluatedAt],
  );

  const campaigns = result.rows.map((row): SourceCampaign => {
    const durationSeconds = Number(row.duration_seconds);
    return {
      id: row.id,
      mediaId: row.media_id,
      startAt: isoString(row.start_at),
      endAt: isoString(row.end_at),
      taxiIds: row.taxi_ids ?? [],
      groupIds: row.group_ids ?? [],
      sha256: row.sha256 ?? "",
      sizeBytes: Number(row.size_bytes ?? 0),
      durationMs: Number.isFinite(durationSeconds)
        ? Math.round(durationSeconds * 1000)
        : 0,
    };
  });

  return { taxiId, groupIds, campaigns };
}

