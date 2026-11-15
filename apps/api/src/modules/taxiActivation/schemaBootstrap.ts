/**
 * Uebergangshelfer fuer bereits vorhandene CX-Strukturen.
 *
 * Die Tabellen taxis und device_taxi_assignments stammen aus dem
 * Integrationsstand frueherer Einheiten (u. a. Status-, Statistik- und
 * Tabletverwaltung). Diese Einheit darf keine eigene Migration einfuehren.
 * Der Helfer bleibt ausschliesslich fuer die bestehenden Aufrufer erhalten,
 * bis die Strukturen durch eine Migration bereitgestellt werden.
 *
 * CX-124 selbst verwendet ihn nicht: der Aktivzustand setzt die Strukturen
 * voraus und meldet fehlende Felder als blockiert.
 */
import type { Pool } from "pg";

const SCHEMA_SQL = `
create table if not exists taxis (
  id text primary key, display_name text not null default '',
  active boolean not null default false,
  revision bigint not null default 1 check (revision >= 1)
);
create table if not exists device_taxi_assignments (
  device_id uuid not null references devices(id) on delete cascade,
  taxi_id text not null, active boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (device_id, taxi_id)
);`;

const schemaReady = new WeakMap<Pool, Promise<void>>();

/** Legt fehlende Uebergangsstrukturen genau einmal je Pool an; Wiederholung ist folgenlos. */
export function ensureTaxiActivationSchema(pool: Pool): Promise<void> {
  const pending = schemaReady.get(pool);
  if (pending !== undefined) return pending;
  const created = pool.query(SCHEMA_SQL).then(() => undefined);
  schemaReady.set(pool, created);
  created.catch(() => {
    if (schemaReady.get(pool) === created) schemaReady.delete(pool);
  });
  return created;
}
