-- CX-032 / R-204 (Teil 1): minimaler Kundenstamm.
-- Rein additive Tabelle. Keine Eindeutigkeit des Anzeigenamens, keine
-- Kontakt-, Rechnungs- oder Vertragsdaten und keine Kampagnentabelle.
-- Zeitstempel und Revision werden von der Datenbank vorbelegt.

create table customers (
  id uuid primary key,
  display_name text not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customers_display_name_length check (
    char_length(display_name) >= 1 and char_length(display_name) <= 128
  ),
  constraint customers_revision_positive check (revision >= 1)
);
