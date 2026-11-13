-- CX-078 / R-203: logische Loeschmarkierung fuer Medien.
-- Rein additiv: bestehende Spalten, Bytes und historische Referenzen bleiben
-- unveraendert. Es gibt keine physische Dateiloeschung und keine automatische
-- Bereinigung. Markierte Medien sind nur noch fuer bestehende Manifest- und
-- Downloadpfade lesbar; normale Listen und neue Zuordnungen blenden sie aus.

alter table media_objects
  add column deleted_at timestamptz null;

-- Markierte Zeilen bleiben fuer Betriebsabfragen auffindbar, ohne bestehende
-- Indizes zu aendern.
create index media_objects_deleted_idx
  on media_objects (deleted_at)
  where deleted_at is not null;
