-- CX-159: Abspielnachweis der Tablets.
-- Eine Zeile je Geraet und play_id; die Primaerschluesselkombination macht
-- Wiederholungen idempotent. Bewusst keine Fremdschluessel auf Kampagnen oder
-- Medien, damit historische Nachweise nicht durch spaetere Loeschungen
-- ungueltig werden. taxi_id ist die zum Annahmezeitpunkt aktive Zuordnung.

create table if not exists spot_plays (
  device_id uuid not null references devices(id) on delete cascade,
  play_id uuid not null,
  taxi_id text null,
  campaign_id uuid not null,
  media_id uuid not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  played_ms integer not null,
  completed boolean not null,
  received_at timestamptz not null,
  primary key (device_id, play_id),
  constraint spot_plays_played_ms_range check (
    played_ms >= 0 and played_ms <= 3600000
  ),
  constraint spot_plays_time_order check (ended_at >= started_at)
);

create index if not exists spot_plays_started_at_idx
  on spot_plays (started_at);
