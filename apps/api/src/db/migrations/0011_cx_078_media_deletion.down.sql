-- Rueckweg der additiven CX-078-Migration. Nur in dev/test zulaessig.
drop index if exists media_objects_deleted_idx;
alter table media_objects
  drop column if exists deleted_at;
