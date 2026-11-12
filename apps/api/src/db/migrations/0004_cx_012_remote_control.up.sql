-- CX-012 / WP-214: taxiweiter, idempotenter Pausenauftragskern.
-- Kein HTTP, kein automatisches Pausenende, keine Fahrzeugbereitschaft.
-- Sollzustaende sind explizit; Revisionen steigen je Taxi. Eine Zeile je
-- Taxi serialisiert konkurrierende Aenderungen ueber "select ... for update".

create table remote_control_taxi_state (
  taxi_id text primary key,
  revision bigint not null check (revision >= 0),
  desired_paused boolean not null,
  updated_at timestamptz not null
);

create table remote_control_commands (
  command_id uuid primary key,
  taxi_id text not null,
  revision bigint not null check (revision >= 1),
  desired_paused boolean not null,
  origin text not null check (origin = 'admin'),
  actor_id text not null,
  content_fingerprint text not null,
  issued_at timestamptz not null,
  constraint remote_control_commands_taxi_revision_unique
    unique (taxi_id, revision)
);

create index remote_control_commands_taxi_revision_idx
  on remote_control_commands (taxi_id, revision desc);

create table remote_control_deliveries (
  id bigint generated always as identity primary key,
  command_id uuid not null
    references remote_control_commands(command_id),
  taxi_id text not null,
  device_id uuid not null references devices(id),
  revision bigint not null check (revision >= 1),
  status text not null check (status in ('pending', 'applied', 'superseded')),
  created_at timestamptz not null,
  acknowledged_at timestamptz null,
  superseded_at timestamptz null,
  constraint remote_control_deliveries_command_device_unique
    unique (command_id, device_id),
  constraint remote_control_deliveries_applied_consistency check (
    (status = 'applied' and acknowledged_at is not null) or
    (status <> 'applied' and acknowledged_at is null)
  ),
  constraint remote_control_deliveries_superseded_consistency check (
    (status = 'superseded' and superseded_at is not null) or
    (status <> 'superseded' and superseded_at is null)
  )
);

-- Neueste ausstehende Zustellung je Geraet sowie Aufraeumen je Taxi.
create index remote_control_deliveries_device_pending_idx
  on remote_control_deliveries (device_id, revision desc)
  where status = 'pending';

create index remote_control_deliveries_taxi_pending_idx
  on remote_control_deliveries (taxi_id, revision)
  where status = 'pending';
