-- GT-ADS-001 Migration 0001 (rueckwaerts)
-- Entfernt alle in Migration 0001 angelegten Tabellen samt Indizes/Constraints.
-- Der Aufrufer (migrate.ts) stellt sicher, dass nur dev/test ausgefuehrt wird.
drop table if exists
  audit_events,
  admin_sessions,
  device_access_tokens,
  device_auth_challenges,
  devices,
  registration_codes
cascade;
