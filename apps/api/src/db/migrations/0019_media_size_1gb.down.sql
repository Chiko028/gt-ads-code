-- Rueckweg zu 0007. Schlaegt bewusst fehl, solange Medien ueber 20 MB gespeichert
-- sind; es werden keine Daten geloescht.
alter table media_objects drop constraint if exists media_objects_size_bytes_check;
alter table media_objects add constraint media_objects_size_bytes_check check (
  size_bytes is null or (size_bytes >= 1 and size_bytes <= 20000000)
);
