-- CX-028 / R-003: dauerhafte technische Alarmepisoden und Versandauftraege.
-- Ersetzt den Persistenzteil von CX-020. Kein HTTP, kein Scheduler, kein Versand.
-- Der Ressourcenstand serialisiert Auswertungen je Ressource; eine Teilindex-
-- Regel erzwingt hoechstens eine offene Episode je Ressource und ein
-- eindeutiger Schluessel hoechstens einen Versandauftrag je Episode.

create table technical_alarm_resource_state (
  resource_id text primary key check (resource_id <> ''),
  last_evaluation_version bigint not null check (
    last_evaluation_version >= 1 and
    last_evaluation_version <= 9007199254740991
  ),
  last_evaluation_id text not null check (last_evaluation_id <> ''),
  last_classification text not null check (last_classification in (
    'healthy',
    'paused_conscious',
    'vehicle_off_expected',
    'technical_fault',
    'unknown'
  )),
  updated_at timestamptz not null
);

create table technical_alarm_episodes (
  episode_id bigint generated always as identity primary key,
  resource_id text not null check (resource_id <> ''),
  status text not null check (status in ('open', 'resolved')),
  error_code text not null check (error_code ~ '^[A-Za-z][A-Za-z0-9_.-]{0,63}$'),
  fault_started_at timestamptz not null,
  detected_at timestamptz not null,
  resolved_at timestamptz null,
  opened_evaluation_id text not null check (opened_evaluation_id <> ''),
  opened_evaluation_version bigint not null check (
    opened_evaluation_version >= 1 and
    opened_evaluation_version <= 9007199254740991
  ),
  resolution_evaluation_id text null check (
    resolution_evaluation_id is null or resolution_evaluation_id <> ''
  ),
  constraint technical_alarm_episodes_resolution_consistent check (
    (status = 'open' and resolved_at is null and resolution_evaluation_id is null) or
    (status = 'resolved' and resolved_at is not null and resolution_evaluation_id is not null)
  )
);

create unique index technical_alarm_episodes_one_open_idx
  on technical_alarm_episodes (resource_id)
  where status = 'open';

create index technical_alarm_episodes_resource_idx
  on technical_alarm_episodes (resource_id, detected_at desc);

create table technical_alarm_outbox (
  outbox_id bigint generated always as identity primary key,
  episode_id bigint not null unique
    references technical_alarm_episodes(episode_id),
  resource_id text not null check (resource_id <> ''),
  message_kind text not null check (message_kind = 'technical_alarm_opened'),
  status text not null check (status in (
    'pending',
    'leased',
    'sent',
    'failed',
    'cancelled'
  )),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz null,
  lease_owner text null,
  lease_expires_at timestamptz null,
  last_error_code text null check (
    last_error_code is null or
    last_error_code ~ '^[A-Za-z0-9_.-]{1,64}$'
  ),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint technical_alarm_outbox_lease_consistent check (
    (lease_owner is null and lease_expires_at is null) or
    (lease_owner is not null and lease_expires_at is not null)
  )
);

create index technical_alarm_outbox_pending_idx
  on technical_alarm_outbox (status, next_attempt_at)
  where status in ('pending', 'leased');
