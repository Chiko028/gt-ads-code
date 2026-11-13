-- CX-041 / R-301: dauerhafter Manifest-Neuberechnungsstand je Taxi.
-- Rein additive Persistenz. Es gibt keine Aenderung an bestehenden Tabellen,
-- keine HTTP-, Scheduler- oder Vertragsaenderung.
--
-- taxi_group_memberships ist die minimale, bisher fehlende Taxi-/Gruppen-
-- zuordnung. Sie wird ausschliesslich von der R-301-Orchestrierung gelesen und
-- von deren schmalem Zuordnungsdienst geschrieben.
--
-- taxi_manifest_state haelt angeforderte und verarbeitete Revision sowie den
-- bereinigten letzten Fehler. Artefakte sind unveraenderlich und werden ueber
-- (taxi_id, version) idempotent gespeichert.

create table taxi_group_memberships (
  group_id text not null,
  taxi_id text not null,
  primary key (group_id, taxi_id),
  constraint taxi_group_memberships_group_id_length check (
    char_length(group_id) between 1 and 128
  ),
  constraint taxi_group_memberships_taxi_id_length check (
    char_length(taxi_id) between 1 and 128
  )
);

create index taxi_group_memberships_taxi_idx
  on taxi_group_memberships (taxi_id, group_id);

create table taxi_manifest_state (
  taxi_id text primary key,
  requested_revision bigint not null default 0,
  processed_revision bigint not null default 0,
  current_version text null,
  current_revision bigint null,
  last_error text null,
  updated_at timestamptz not null,
  constraint taxi_manifest_state_taxi_id_length check (
    char_length(taxi_id) between 1 and 128
  ),
  constraint taxi_manifest_state_revision_order check (
    requested_revision >= 0 and
    processed_revision >= 0 and
    processed_revision <= requested_revision
  ),
  constraint taxi_manifest_state_version_format check (
    current_version is null or current_version ~ '^[0-9a-f]{64}$'
  ),
  constraint taxi_manifest_state_current_revision_check check (
    current_revision is null or current_revision >= 0
  )
);

create index taxi_manifest_state_pending_idx
  on taxi_manifest_state (taxi_id)
  where requested_revision > processed_revision;

create table taxi_manifest_artifacts (
  taxi_id text not null,
  version text not null,
  key_id text not null,
  environment text not null,
  payload_base64 text not null,
  signature_base64 text not null,
  source_revision bigint not null,
  created_at timestamptz not null,
  primary key (taxi_id, version),
  constraint taxi_manifest_artifacts_taxi_id_length check (
    char_length(taxi_id) between 1 and 128
  ),
  constraint taxi_manifest_artifacts_version_format check (
    version ~ '^[0-9a-f]{64}$'
  ),
  constraint taxi_manifest_artifacts_environment_known check (
    environment in ('dev', 'test')
  ),
  constraint taxi_manifest_artifacts_source_revision_check check (
    source_revision >= 1
  )
);

create index taxi_manifest_artifacts_taxi_created_idx
  on taxi_manifest_artifacts (taxi_id, created_at desc, version asc);
