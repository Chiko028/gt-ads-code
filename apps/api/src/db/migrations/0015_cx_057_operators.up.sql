-- CX-057 / R-602: persistente Operatorkonten und Sperrung.
-- Additiv: keine Aenderung bestehender Migrationen, keine Seeds, keine
-- Klartextpasswoerter. Gespeichert wird ausschliesslich ein gesalzener
-- scrypt-Hash samt versionierten Parametern.
--
-- Sitzungen des bisherigen konfigurierten Administrators bleiben ohne
-- actor_id (NULL); der Sitzungsresolver bildet sie auf die feste Identitaet
-- "legacy-admin" ab. Operator-Sitzungen tragen die stabile actor_id aus
-- dieser Tabelle und werden bei jeder Autorisierung erneut auf status
-- 'active' geprueft.

create table operators (
  actor_id uuid primary key,
  username text not null,
  password_hash text not null,
  status text not null check (status in ('active', 'disabled')),
  created_at timestamptz not null,
  disabled_at timestamptz null,
  constraint operators_username_format_check check (
    username = lower(username)
    and username ~ '^[a-z0-9._-]{3,64}$'
  ),
  constraint operators_status_timestamp_check check (
    (status = 'active' and disabled_at is null)
    or (status = 'disabled' and disabled_at is not null)
  ),
  constraint operators_disabled_at_check check (
    disabled_at is null or disabled_at >= created_at
  )
);

-- Eindeutiger Index auf der bereits normalisierten Kennung.
create unique index operators_username_unique_idx on operators (username);
create index operators_status_idx on operators (status);

alter table admin_sessions add column actor_id uuid null;

alter table admin_sessions
  add constraint admin_sessions_actor_id_fkey
  foreign key (actor_id) references operators(actor_id) on delete restrict;

create index admin_sessions_actor_id_idx on admin_sessions (actor_id);
