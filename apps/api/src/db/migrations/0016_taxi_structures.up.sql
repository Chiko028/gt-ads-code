-- CX-131 / R-001: taxis und device_taxi_assignments als Migration.
-- Die Struktur entspricht exakt apps/api/src/modules/taxiActivation/
-- schemaBootstrap.ts. "if not exists" erhaelt bestehende Datenbanken, in
-- denen die Tabellen bereits per Laufzeit-Bootstrap angelegt wurden.

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
);
