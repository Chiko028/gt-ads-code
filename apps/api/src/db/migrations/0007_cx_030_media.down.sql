-- CX-030: Rueckweg fuer dev/test (additive Tabelle).
drop index if exists media_objects_staging_idx;
drop index if exists media_objects_ready_list_idx;
drop table if exists media_objects;
