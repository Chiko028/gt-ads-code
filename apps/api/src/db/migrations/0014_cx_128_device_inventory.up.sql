-- CX-128 / R-106 (Teil 1): revisionsgesichertes Inventar je bestehendem Tablet.
-- Additiv und optional: genau ein 1:1-Satz je Geraet, keine Kopie von
-- Geraeteidentitaet oder Aktivzustand. Fehlender Satz entspricht Revision 0.

create table device_inventory (
  device_id uuid primary key references devices(id) on delete cascade,
  serial_number text null check (
    serial_number is null
    or (serial_number <> '' and char_length(serial_number) <= 128)
  ),
  device_type text null check (
    device_type is null
    or (device_type <> '' and char_length(device_type) <= 64)
  ),
  replacement_note text null check (
    replacement_note is null
    or (replacement_note <> '' and char_length(replacement_note) <= 1000)
  ),
  revision integer not null check (revision >= 1)
);
