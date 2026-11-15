/**
 * CX-101 / R-204 (Teil 2): Kampagnenentwurf speichern.
 *
 * Genau eine exportierte Servicefunktion legt einen Entwurf an. Betreiber-
 * und Akteurskennung kommen ausschliesslich aus dem vertrauenswuerdigen
 * Sitzungskontext und nie aus dem Request-Body. Referenzpruefung (Kunde,
 * Medium) und Laufzeitpruefung (CX-004) laufen vor dem Schreiben; Einfuegen
 * und bereinigtes U3-Audit laufen auf genau einem Transaktionsclient. Ein
 * Fehler bei Referenz, Medium oder Audit rollt den gesamten Entwurf zurueck.
 *
 * Bewusst NICHT enthalten: Aktivierung, Statuswechsel, Zielzuordnung,
 * Manifestberechnung und eine zweite Belegungspruefung.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ApiError } from "../../http/errors.js";
import type { SqlQueryable } from "../audit/repository.js";
import { AuditService } from "../audit/service.js";
import {
  CAMPAIGN_AUDIT_TARGET_TYPE,
  CAMPAIGN_CREATED_ACTION,
  CAMPAIGN_RULE_TYPE,
  normalizeCampaignUuid,
} from "./campaigns.js";
import { validateCampaignRuntime } from "./runtimeWindow.js";

/** Der Entwurf ist die einzige Statuswirkung dieses Schritts. */
export const CAMPAIGN_DRAFT_STATUS = "draft" as const;

/** Ein einziges Audit-Ereignis je angelegtem Entwurf. */
export const CAMPAIGN_DRAFT_CREATED_ACTION = CAMPAIGN_CREATED_ACTION;

/** Freigegebene Audit-Feldnamen; niemals Werte. */
export const CAMPAIGN_DRAFT_AUDIT_FIELDS = Object.freeze([
  "customer_id",
  "media_id",
  "start_at",
  "end_at",
  "status",
] as const);

export interface SaveCampaignDraftOptions {
  pool: Pool;
  /** Vertrauenswuerdiger Betreiberkontext, z. B. aus der Admin-Sitzung. */
  ownerId: unknown;
  /** Vertrauenswuerdiger Akteur fuer das Audit, nicht aus dem Request. */
  actorId: unknown;
  customerId: unknown;
  mediaId: unknown;
  startAt: unknown;
  endAt: unknown;
  /** Nur fuer deterministische Tests; Standard ist die vorhandene UUID-Quelle. */
  idFactory?: () => string;
  now?: () => Date;
}

export interface CampaignDraft {
  id: string;
  customerId: string;
  mediaId: string;
  ownerId: string;
  ruleType: typeof CAMPAIGN_RULE_TYPE;
  status: typeof CAMPAIGN_DRAFT_STATUS;
  archived: boolean;
  startAt: string;
  endAt: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

interface CampaignDraftRow {
  id: string;
  customer_id: string;
  media_id: string;
  owner_id: string;
  status: string;
  archived: boolean;
  start_at: string;
  end_at: string;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

const DRAFT_COLUMNS = [
  "c.id::text as id",
  "c.customer_id::text as customer_id",
  "c.media_id::text as media_id",
  "c.owner_id",
  "c.status",
  "c.archived",
  "to_char(c.start_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as start_at",
  "to_char(c.end_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as end_at",
  "c.revision",
  "c.created_at",
  "c.updated_at",
].join(", ");

/** Akzeptiert ausschliesslich eine nichtleere Kontextkennung. */
function normalizeContextId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw ApiError.invalidRequest();
  }
  return value;
}

function toDraft(row: CampaignDraftRow): CampaignDraft {
  if (row.status !== CAMPAIGN_DRAFT_STATUS) {
    throw new Error("Gespeicherter Kampagnenstatus ist kein Entwurf");
  }
  return {
    id: row.id,
    customerId: row.customer_id,
    mediaId: row.media_id,
    ownerId: row.owner_id,
    ruleType: CAMPAIGN_RULE_TYPE,
    status: CAMPAIGN_DRAFT_STATUS,
    archived: row.archived,
    startAt: row.start_at,
    endAt: row.end_at,
    revision: row.revision,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Prueft Kunde und Medium auf demselben Transaktionsclient. Kunden und Medien
 * sind im vorhandenen Schema betreiberglobale Stammdaten ohne eigene
 * owner_id-Spalte; die Betreiberbindung entsteht deshalb ausschliesslich am
 * Entwurf (owner_id aus dem vertrauenswuerdigen Kontext). Die Mediumsperre
 * teilt sich mit der Loeschmarkierung aus CX-078, damit kein Entwurf an einem
 * gerade geloeschten Medium entsteht.
 */
async function assertDraftReferences(
  client: SqlQueryable,
  customerId: string,
  mediaId: string,
): Promise<void> {
  const customer = await client.query(
    "select 1 from customers where id = $1::uuid for share",
    [customerId],
  );
  if (customer.rowCount !== 1) {
    throw ApiError.invalidRequest();
  }

  const media = await client.query<{
    status: string;
    deleted_at: Date | null;
  }>(
    [
      "select status, deleted_at",
      "  from media_objects",
      " where id = $1::uuid",
      "   for share",
    ].join("\n"),
    [mediaId],
  );
  const row = media.rows[0];
  if (row === undefined || row.deleted_at !== null || row.status !== "ready") {
    throw ApiError.invalidRequest();
  }
}

/**
 * Legt genau einen Kampagnenentwurf an. Der Aufrufer muss Betreiber und
 * Akteur aus der bereits autorisierten Sitzung uebergeben; beide Werte werden
 * hier nie aus Nutzereingaben abgeleitet. Alle Schreibwirkungen (Entwurf und
 * Audit) laufen in einer Transaktion, die bei jedem Fehler vollstaendig
 * zurueckgerollt wird.
 */
export async function saveCampaignDraft(
  options: SaveCampaignDraftOptions,
): Promise<CampaignDraft> {
  const ownerId = normalizeContextId(options.ownerId);
  const actorId = normalizeContextId(options.actorId);
  const customerId = normalizeCampaignUuid(options.customerId);
  const mediaId = normalizeCampaignUuid(options.mediaId);
  const runtime = validateCampaignRuntime(options.startAt, options.endAt);
  if (!runtime.ok) {
    throw ApiError.invalidRequest();
  }

  const id = (options.idFactory ?? (() => randomUUID()))();
  const at = (options.now ?? (() => new Date()))();
  const audit = new AuditService({ executor: options.pool });
  const client = await options.pool.connect();

  try {
    await client.query("begin");
    await assertDraftReferences(client, customerId, mediaId);

    const inserted = await client.query<CampaignDraftRow>(
      [
        "insert into campaigns as c",
        "  (id, customer_id, media_id, owner_id, rule_type, status, archived,",
        "   start_at, end_at, revision, created_at, updated_at)",
        "values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, false,",
        "        $7::timestamptz, $8::timestamptz, 1, $9, $9)",
        "returning " + DRAFT_COLUMNS,
      ].join("\n"),
      [
        id,
        customerId,
        mediaId,
        ownerId,
        CAMPAIGN_RULE_TYPE,
        CAMPAIGN_DRAFT_STATUS,
        runtime.value.startAt,
        runtime.value.endAt,
        at,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error("Kampagnenentwurf wurde nicht angelegt");
    }

    // Bereinigtes U3-Audit: nur freigegebene Feldnamen, keine Werte und
    // keine Geheimnisse. Der Fehlerfall rollt den Entwurf mit zurueck.
    await audit.recordWith(
      client,
      {
        actorType: "admin",
        actorId,
        action: CAMPAIGN_DRAFT_CREATED_ACTION,
        targetType: CAMPAIGN_AUDIT_TARGET_TYPE,
        targetId: row.id,
        details: { fields: [...CAMPAIGN_DRAFT_AUDIT_FIELDS] },
      },
      at,
    );

    await client.query("commit");
    return toDraft(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
