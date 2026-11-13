/**
 * CX-041 / R-301: transaktionsgebundene Markierungsfunktionen.
 *
 * Alle Funktionen laufen ausschliesslich auf dem Client der laufenden
 * Fachmutation. Dadurch committen oder rollen Fachzustand, Audit und
 * Markierung gemeinsam zurueck. Die Markierung zaehlt je Aufruf genau eine
 * angeforderte Revision pro betroffenem Taxi; doppelte Taxi-IDs und
 * ueberlappende Gruppen werden vorher entdupliziert.
 */
import type { SqlQueryable } from "../audit/repository.js";

export const TAXI_MANIFEST_STATE_TABLE = "taxi_manifest_state";
export const TAXI_GROUP_MEMBERSHIPS_TABLE = "taxi_group_memberships";

export class ManifestMarkingError extends Error {
  readonly code: "missing_migration" | "invalid_taxi_id";

  constructor(
    code: "missing_migration" | "invalid_taxi_id",
    message: string,
  ) {
    super(message);
    this.name = "ManifestMarkingError";
    this.code = code;
  }
}

/** Prueft eine Tabelle ueber den aktuellen search_path, ohne sie anzulegen. */
export async function relationExists(
  executor: SqlQueryable,
  relation: string,
): Promise<boolean> {
  const result = await executor.query<{ present: boolean }>(
    "select to_regclass($1) is not null as present",
    [relation],
  );
  return result.rows[0]?.present === true;
}

function normalizeIds(ids: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim();
    if (id.length === 0 || id.length > 128) {
      throw new ManifestMarkingError(
        "invalid_taxi_id",
        "Taxi-IDs muessen 1 bis 128 Zeichen enthalten.",
      );
    }
    unique.add(id);
  }
  return [...unique].sort();
}

/**
 * Erhoeht die angeforderte Revision je Taxi genau einmal. Die verarbeitete
 * Revision bleibt unveraendert, offene Arbeit bleibt also offen.
 */
export async function markTaxiRevisions(
  executor: SqlQueryable,
  taxiIds: readonly string[],
  at: Date,
): Promise<string[]> {
  const ids = normalizeIds(taxiIds);
  if (ids.length === 0) {
    return [];
  }

  await executor.query(
    [
      "insert into taxi_manifest_state",
      "  (taxi_id, requested_revision, processed_revision,",
      "   current_version, current_revision, last_error, updated_at)",
      "select id, 1, 0, null, null, null, $2",
      "  from unnest($1::text[]) as id",
      "on conflict (taxi_id) do update",
      "   set requested_revision =",
      "         taxi_manifest_state.requested_revision + 1,",
      "       updated_at = excluded.updated_at",
    ].join("\n"),
    [ids, at],
  );

  return ids;
}

export interface CampaignAssignment {
  taxiIds: readonly string[];
  groupIds: readonly string[];
}

async function groupMemberIds(
  executor: SqlQueryable,
  groupIds: readonly string[],
): Promise<string[]> {
  const ids = normalizeIds(groupIds);
  if (ids.length === 0) {
    return [];
  }

  if (!(await relationExists(executor, TAXI_GROUP_MEMBERSHIPS_TABLE))) {
    throw new ManifestMarkingError(
      "missing_migration",
      "Die Migration fuer Taxi-/Gruppenzuordnungen fehlt.",
    );
  }

  const result = await executor.query<{ taxi_id: string }>(
    [
      "select distinct taxi_id",
      "  from taxi_group_memberships",
      " where group_id = any($1::text[])",
      " order by taxi_id asc",
    ].join("\n"),
    [ids],
  );
  return result.rows.map((row) => row.taxi_id);
}

/**
 * Kampagnenaenderung: markiert die Vereinigungsmenge der vorher und nachher
 * zugeordneten Taxis. Direkte Ziele und alle Gruppenmitglieder der beteiligten
 * Gruppen werden entdupliziert; entfernte Ziele bleiben enthalten.
 */
export async function markCampaignChange(
  executor: SqlQueryable,
  before: CampaignAssignment | null,
  after: CampaignAssignment | null,
  at: Date,
): Promise<string[]> {
  if (before === null && after === null) {
    return [];
  }

  if (!(await relationExists(executor, TAXI_MANIFEST_STATE_TABLE))) {
    // Ohne die additive Migration gibt es keinen Markierungsstand. Bestehende
    // Module bleiben dadurch in alten Test- und Integrationsschemata nutzbar;
    // die R-301-Tests setzen die Migration voraus.
    return [];
  }

  const groups = [
    ...(before?.groupIds ?? []),
    ...(after?.groupIds ?? []),
  ];
  const members = await groupMemberIds(executor, groups);
  const affected = normalizeIds([
    ...(before?.taxiIds ?? []),
    ...(after?.taxiIds ?? []),
    ...members,
  ]);

  await markTaxiRevisions(executor, affected, at);
  return affected;
}

interface CampaignTargetRow {
  taxi_ids: string[] | null;
  group_ids: string[] | null;
}

/**
 * Medienaenderung: markiert alle Taxis, die ueber eine aktive Kampagne auf
 * dieses Medium verweisen. Die Referenzen aendern sich durch die Medien-
 * mutation nicht, deshalb ist vorher und nachher dieselbe Menge massgeblich.
 */
export async function markMediaChange(
  executor: SqlQueryable,
  mediaId: string,
  at: Date,
): Promise<string[]> {
  if (
    !(await relationExists(executor, "campaigns")) ||
    !(await relationExists(executor, "campaign_targets"))
  ) {
    return [];
  }

  if (!(await relationExists(executor, TAXI_MANIFEST_STATE_TABLE))) {
    throw new ManifestMarkingError(
      "missing_migration",
      "Die Migration fuer den Manifest-Neuberechnungsstand fehlt.",
    );
  }

  const campaigns = await executor.query<CampaignTargetRow>(
    [
      "select",
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
      " where c.media_id = $1::uuid",
      "   and c.status = 'active'",
      "   and c.archived = false",
      " order by c.id asc",
    ].join("\n"),
    [mediaId],
  );

  const members = await groupMemberIds(
    executor,
    campaigns.rows.flatMap((row) => row.group_ids ?? []),
  );
  const affected = normalizeIds([
    ...campaigns.rows.flatMap((row) => row.taxi_ids ?? []),
    ...members,
  ]);

  await markTaxiRevisions(executor, affected, at);
  return affected;
}

/**
 * Zuordnungsaenderung: betroffen sind genau die Mitglieder vor und nach der
 * Aenderung, sofern mindestens eine aktive Kampagne die Gruppe als Ziel nennt.
 * Ohne eine solche Kampagne hat die Mitgliedschaft keinen Manifestbezug.
 */
export async function markGroupMembershipChange(
  executor: SqlQueryable,
  groupId: string,
  beforeMembers: readonly string[],
  afterMembers: readonly string[],
  at: Date,
): Promise<string[]> {
  if (!(await relationExists(executor, TAXI_MANIFEST_STATE_TABLE))) {
    throw new ManifestMarkingError(
      "missing_migration",
      "Die Migration fuer den Manifest-Neuberechnungsstand fehlt.",
    );
  }

  if (
    !(await relationExists(executor, "campaigns")) ||
    !(await relationExists(executor, "campaign_targets"))
  ) {
    return [];
  }

  const targeted = await executor.query(
    [
      "select 1",
      "  from campaign_targets t",
      "  join campaigns c on c.id = t.campaign_id",
      " where t.kind = 'group'",
      "   and t.target_id = $1",
      "   and c.status = 'active'",
      "   and c.archived = false",
      " limit 1",
    ].join("\n"),
    [groupId],
  );

  if ((targeted.rowCount ?? 0) === 0) {
    return [];
  }

  const affected = normalizeIds([...beforeMembers, ...afterMembers]);
  await markTaxiRevisions(executor, affected, at);
  return affected;
}
