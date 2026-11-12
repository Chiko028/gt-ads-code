-- CX-009 / GT-ADS-004: dauerhafte, idempotente Telemetrie-Beobachtungen.
-- Die Geraete-ID kommt aus dem authentifizierten Kontext; event_id ist die
-- fachliche Idempotenz-ID je Geraet. received_at ist ausschliesslich Serverzeit.

create table telemetry_observations (
  id bigint generated always as identity primary key,
  device_id uuid not null references devices(id),
  event_id uuid not null,
  occurred_at timestamptz not null,
  vehicle_ready boolean null,
  paused boolean null,
  playback text not null check (playback in ('playing', 'stopped', 'unknown')),
  technical_fault boolean null,
  received_at timestamptz not null,
  constraint telemetry_observations_device_event_unique
    unique (device_id, event_id)
);

-- Auswertungen lesen je Geraet einen Zeitraum und brechen Gleichstaende
-- deterministisch ueber die Ereignis-ID. Keine Last-/Retention-Logik.
create index telemetry_observations_device_occurred_event_idx
  on telemetry_observations (device_id, occurred_at, event_id);
