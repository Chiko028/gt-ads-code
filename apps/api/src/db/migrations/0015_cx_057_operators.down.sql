-- CX-057 / R-602: Rueckweg der Operatorerweiterung.
-- Nur in dev/test ausfuehrbar (bestehender Down-Guard).
--
-- Vor dem Entfernen von actor_id werden alle Operator-Sitzungen geloescht.
-- Sonst wuerde eine fehlende actor_id nach dem Rollback als NULL gelesen und
-- der Sitzungsresolver wuerde vorhandene Operator-Tokens (auch zuvor
-- gesperrter Operatoren) als Legacy-Admin akzeptieren.

delete from admin_sessions where actor_id is not null;

drop index if exists admin_sessions_actor_id_idx;
alter table admin_sessions
  drop constraint if exists admin_sessions_actor_id_fkey;
alter table admin_sessions drop column if exists actor_id;
drop table if exists operators;
