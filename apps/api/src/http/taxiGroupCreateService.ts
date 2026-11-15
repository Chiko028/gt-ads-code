/**
 * R-104 / CX-114: Anlagefunktion des Taxigruppen-Bestands.
 *
 * Einziger Schreibweg zum Anlegen einer leeren Gruppe: Identitaet, Betreiber
 * und Revision entstehen serverseitig, Audit und Datensatz auf demselben
 * Transaktionsclient. Die HTTP-Schicht (CX-115) ruft die Funktion genau einmal
 * auf und beschraenkt sich auf Schutz, DTO, Fehlerabbildung und Antwort.
 *
 * Schema und Datensatz entstehen in derselben Transaktion. Schlaegt die Anlage
 * fehl, bleibt keine Schemaaenderung zurueck; ein doppelter Name wird als
 * Konflikt abgebildet, die Datenbank entscheidet auch bei Parallelitaet.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { insertAuditEvent } from "../modules/audit/repository.js";

export const TAXI_GROUP_CREATED_ACTION = "taxi_group.created";
export const TAXI_GROUP_AUDIT_TARGET_TYPE = "taxi_group";
export const MAX_TAXI_GROUP_NAME_LENGTH = 120;

export interface CreateTaxiGroupInput {
  /** Rohwert aus dem geschlossenen DTO; wird hier normalisiert. */
  name: unknown;
  /** Vertrauenswuerdiger Betreiberbereich; nie aus dem Request. */
  ownerId: string;
  /** Vertrauenswuerdiger Auditakteur; nie aus dem Request. */
  actorId: string;
  at: Date;
}

export interface CreatedTaxiGroup {
  id: string;
  name: string;
  revision: number;
}

export type TaxiGroupCreateErrorCode = "invalid_request" | "conflict";

export class TaxiGroupCreateError extends Error {
  readonly code: TaxiGroupCreateErrorCode;

  constructor(code: TaxiGroupCreateErrorCode, message: string) {
    super(message);
    this.name = "TaxiGroupCreateError";
    this.code = code;
  }
}

const SCHEMA_SQL = `
create table if not exists taxi_groups (
  id uuid primary key,
  name text not null,
  owner_id text not null default 'legacy-admin',
  revision integer not null default 1,
  created_at timestamptz not null,
  constraint taxi_groups_name_unique unique (name),
  constraint taxi_groups_name_length check (char_length(name) between 1 and 120),
  constraint taxi_groups_revision_positive check (revision >= 1)
);
alter table taxi_groups
  add column if not exists owner_id text not null default 'legacy-admin';
`;

const INSERT_SQL = `
insert into taxi_groups (id, name, revision, created_at, owner_id)
values ($1, $2, 1, $3, $4)
returning id, name, revision::int as revision
`;

const schemaReady = new WeakMap<Pool, Promise<void>>();

/**
 * Stellt den additiven Bestand fuer Leser und die Umbenennung genau einmal je
 * Pool bereit. Die Anlage selbst fuehrt dieselbe DDL in ihrer Transaktion aus.
 */
export function ensureTaxiGroupSchema(pool: Pool): Promise<void> {
  const pending = schemaReady.get(pool);
  if (pending !== undefined) {
    return pending;
  }
  const created = pool.query(SCHEMA_SQL).then(() => undefined);
  schemaReady.set(pool, created);
  created.catch(() => {
    if (schemaReady.get(pool) === created) {
      schemaReady.delete(pool);
    }
  });
  return created;
}

function fail(code: TaxiGroupCreateErrorCode, message: string): never {
  throw new TaxiGroupCreateError(code, message);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length < 1) {
    fail("invalid_request", label + " muss ein nichtleerer Text sein.");
  }
  return value.trim();
}

function normalizeName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length < 1 || name.length > MAX_TAXI_GROUP_NAME_LENGTH) {
    fail(
      "invalid_request",
      "Der Gruppenname muss 1 bis " +
        MAX_TAXI_GROUP_NAME_LENGTH +
        " Zeichen enthalten.",
    );
  }
  return name;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

/** Legt genau eine leere Gruppe mit genau einem Audit-Eintrag an. */
export async function createTaxiGroup(
  pool: Pool,
  input: CreateTaxiGroupInput,
): Promise<CreatedTaxiGroup> {
  const name = normalizeName(input.name);
  const ownerId = requireText(input.ownerId, "Der Betreiber");
  const actorId = requireText(input.actorId, "Der Akteur");
  if (!(input.at instanceof Date) || Number.isNaN(input.at.getTime())) {
    throw new Error("Die Serveruhr liefert keinen gueltigen Zeitpunkt.");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    // DDL und Anlage in einer Transaktion; bei Fehlschlag wird beides
    // zurueckgerollt. Die Anweisung ist idempotent.
    await client.query(SCHEMA_SQL);
    const inserted = await client.query<{
      id: string;
      name: string;
      revision: number;
    }>(INSERT_SQL, [randomUUID(), name, input.at, ownerId]);
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error("Gruppe wurde nicht gespeichert");
    }
    await insertAuditEvent(client, {
      at: input.at,
      actorType: "admin",
      actorId,
      action: TAXI_GROUP_CREATED_ACTION,
      targetType: TAXI_GROUP_AUDIT_TARGET_TYPE,
      targetId: row.id,
      details: { name: row.name },
    });
    await client.query("commit");
    return { id: row.id, name: row.name, revision: row.revision };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Der urspruengliche Fehler bleibt massgeblich.
    }
    if (error instanceof TaxiGroupCreateError) {
      throw error;
    }
    if (isUniqueViolation(error)) {
      fail("conflict", "Eine Gruppe mit diesem Namen existiert bereits.");
    }
    throw error;
  } finally {
    client.release();
  }
}
