-- Medien bis 1 GB (1.000.000.000 Byte): hebt die 20-MB-Grenze aus 0007 an.
alter table media_objects drop constraint if exists media_objects_size_bytes_check;
alter table media_objects add constraint media_objects_size_bytes_check check (
  size_bytes is null or (size_bytes >= 1 and size_bytes <= 1000000000)
);
