-- CX-168: App-Updates fuer die Tablets.
-- Eine Zeile je hochgeladener App-Version. version_code ist streng steigend
-- und eindeutig, version_name ebenfalls eindeutig. rollout steuert die
-- Freigabe (none|pilot|all).
create table if not exists app_releases (
  id uuid primary key,
  version_code integer not null unique,
  version_name text not null unique,
  notes text null,
  sha256 text not null,
  size_bytes bigint not null,
  rollout text not null default 'none',
  created_at timestamptz not null,
  created_by text not null,
  rollout_changed_at timestamptz null,
  constraint app_releases_version_code_positive check (version_code > 0),
  constraint app_releases_version_name_length check (
    char_length(version_name) >= 1 and char_length(version_name) <= 64
  ),
  constraint app_releases_notes_length check (
    notes is null or char_length(notes) <= 500
  ),
  constraint app_releases_sha256_hex check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint app_releases_size_positive check (size_bytes > 0),
  constraint app_releases_rollout_enum check (
    rollout in ('none', 'pilot', 'all')
  )
);

-- Rueckmeldungen der Tablets je Version; die Kombination ist der Schluessel
-- und macht wiederholte Meldungen idempotent (letzte Meldung gewinnt).
create table if not exists app_release_device_reports (
  device_id uuid not null references devices(id) on delete cascade,
  release_id uuid not null references app_releases(id) on delete cascade,
  status text not null,
  detail text null,
  reported_at timestamptz not null,
  primary key (device_id, release_id),
  constraint app_release_device_reports_status_enum check (
    status in ('downloaded', 'installed', 'failed')
  ),
  constraint app_release_device_reports_detail_format check (
    detail is null or detail ~ '^[a-z0-9_]{1,64}$'
  )
);

-- Update-Kanal je Tablet: stable sieht nur 'all', pilot zusaetzlich 'pilot'.
alter table devices
  add column if not exists update_channel text not null default 'stable';

alter table devices
  drop constraint if exists devices_update_channel_enum;
alter table devices
  add constraint devices_update_channel_enum check (
    update_channel in ('stable', 'pilot')
  );
