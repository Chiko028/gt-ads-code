-- CX-013 / WP-215: versionierte taxiweise Pausenkonfiguration und GPS-Sperre.
-- Keine HTTP-Routen, keine Sensorabfrage, keine Android-Implementierung.
-- gps_mode ist hart auf 'aus' begrenzt; eine administrative Aenderung ist
-- keine Rechtsgrundlage. Null bei den E36/E40-Feldern bedeutet
-- "unentschieden", nicht "unbegrenzt" oder "deaktiviert".

create table control_config_taxi (
  taxi_id text primary key,
  revision bigint not null check (revision >= 0),
  gps_mode text not null check (gps_mode = 'aus'),
  pause_max_duration_s bigint null check (
    pause_max_duration_s is null or
    (pause_max_duration_s > 0 and pause_max_duration_s <= 9007199254740991)
  ),
  pause_end_on_vehicle_off boolean null,
  display_run_on_s bigint null check (
    display_run_on_s is null or
    (display_run_on_s >= 0 and display_run_on_s <= 9007199254740991)
  ),
  updated_at timestamptz not null
);

-- Aenderungshistorie fuer Idempotenz und Audit-Nachvollziehbarkeit.
-- content_fingerprint umfasst Taxi und vollstaendige Konfiguration, nicht
-- expected_revision.
create table control_config_changes (
  change_id text primary key,
  taxi_id text not null,
  revision bigint not null check (revision >= 1),
  content_fingerprint text not null,
  actor_id text not null,
  gps_mode text not null check (gps_mode = 'aus'),
  pause_max_duration_s bigint null check (
    pause_max_duration_s is null or
    (pause_max_duration_s > 0 and pause_max_duration_s <= 9007199254740991)
  ),
  pause_end_on_vehicle_off boolean null,
  display_run_on_s bigint null check (
    display_run_on_s is null or
    (display_run_on_s >= 0 and display_run_on_s <= 9007199254740991)
  ),
  applied_at timestamptz not null,
  constraint control_config_changes_taxi_revision_unique
    unique (taxi_id, revision)
);
