-- GT-ADS-001 Migration 0001 (vorwaerts)
-- Schema exakt ARCHITEKTUR.md §3. Keine Seeds (DATENTRENNUNG §2.2).

create table registration_codes (
  id uuid primary key,
  code_hash bytea not null unique,
  label text null,
  created_at timestamptz not null,
  created_by text not null,
  expires_at timestamptz not null,
  used_at timestamptz null,
  used_by_device_id uuid null,
  revoked_at timestamptz null,
  revoked_by text null
);

create table devices (
  id uuid primary key,
  label text null,
  public_key_spki bytea not null,
  public_key_fingerprint text not null unique,
  state text not null check (state in ('active', 'revoked')),
  manufacturer text not null,
  model text not null,
  os_version text not null,
  sdk_int integer not null,
  app_version text not null,
  app_flavor text not null,
  registration_code_id uuid not null references registration_codes(id),
  registration_request_id uuid not null,
  registered_at timestamptz not null,
  last_seen_at timestamptz not null,
  last_seq bigint not null default 0,
  last_clock_offset_ms bigint null,
  revoked_at timestamptz null,
  revoked_by text null
);

-- Zyklus registration_codes <-> devices: FK nachtraeglich und deferrable,
-- damit beide Zeilen in einer Transaktion angelegt werden koennen.
alter table registration_codes
  add constraint registration_codes_used_by_device_id_fkey
  foreign key (used_by_device_id) references devices(id)
  deferrable initially deferred;

create table device_auth_challenges (
  id uuid primary key,
  device_id uuid not null references devices(id),
  nonce_hash bytea not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  used_at timestamptz null
);

create table device_access_tokens (
  id uuid primary key,
  device_id uuid not null references devices(id),
  token_hash bytea not null unique,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz null
);

create table admin_sessions (
  id uuid primary key,
  token_hash bytea not null unique,
  created_at timestamptz not null,
  expires_at timestamptz not null
);

create table audit_events (
  id bigint generated always as identity primary key,
  at timestamptz not null,
  actor_type text not null check (actor_type in ('admin', 'device', 'system')),
  actor_id text null,
  action text not null,
  target_type text null,
  target_id text null,
  details jsonb not null default '{}'::jsonb
);

create index devices_state_idx on devices (state);
create index devices_last_seen_at_idx on devices (last_seen_at);
create index registration_codes_expires_at_idx on registration_codes (expires_at);
create index device_auth_challenges_expires_at_idx on device_auth_challenges (expires_at);
create index device_access_tokens_expires_at_device_id_idx on device_access_tokens (expires_at, device_id);
