-- CX-011 / WP-212/213: versionierte, korrigierbare Tagesauswertungen.
-- Die Rollup-Zeile ist ein Aggregat; Rohereignisse in telemetry_observations
-- bleiben unveraendert. Es gibt in dieser Migration bewusst keinen
-- Loeschmechanismus und keine Retention-Tabelle.

create table telemetry_daily_rollups (
  id bigint generated always as identity primary key,
  device_id uuid not null references devices(id),
  local_date date not null,
  time_zone text not null,
  policy_version text not null,
  algorithm_version text not null,
  revision integer not null check (revision >= 1),
  evaluation_time timestamptz not null,
  day_start timestamptz not null,
  day_end timestamptz not null,
  day_length_ms bigint not null check (day_length_ms > 0),
  classes jsonb not null,
  coverage jsonb not null,
  expected_playback_ms bigint null check (
    expected_playback_ms is null or expected_playback_ms >= 0
  ),
  expected_playback_reason text null,
  policy_canonical jsonb not null,
  input_fingerprint text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint telemetry_daily_rollups_key_unique unique (
    device_id,
    local_date,
    time_zone,
    policy_version,
    algorithm_version
  ),
  constraint telemetry_daily_rollups_day_order check (day_end > day_start)
);

-- Auswertungsschluessel: Geraet + lokaler Tag + Zeitzone + Policy + Algorithmus.
-- Der Unique-Constraint deckt den Geraete-/Tageszugriff bereits ab; der
-- zusaetzliche Index dient der Retention-Vorschau je Zeitzone.
create index telemetry_daily_rollups_retention_idx
  on telemetry_daily_rollups (time_zone, local_date, algorithm_version);

create index telemetry_daily_rollups_policy_version_idx
  on telemetry_daily_rollups (policy_version);
