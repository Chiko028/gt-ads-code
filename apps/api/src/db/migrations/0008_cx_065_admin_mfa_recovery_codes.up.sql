-- CX-065 / R-605: kontogebundene, einmalige MFA-Wiederherstellungscodes.
-- Additiv: keine HTTP-Route, keine automatische Erzeugung, kein Reset.
-- Gespeichert werden ausschliesslich SHA-256-Hashes; Klartext existiert nur
-- beim Erzeugen im Speicher des Aufrufers.

create table admin_mfa_recovery_code_sets (
  id uuid primary key,
  actor_id text not null check (actor_id <> ''),
  created_at timestamptz not null,
  invalidated_at timestamptz null,
  constraint admin_mfa_recovery_code_sets_invalidation_check check (
    invalidated_at is null or invalidated_at >= created_at
  )
);

-- Hoechstens ein aktiver Codesatz je Konto. Der Austausch entwertet den
-- vorherigen Satz in derselben Transaktion und legt den neuen an.
create unique index admin_mfa_recovery_code_sets_one_active_idx
  on admin_mfa_recovery_code_sets (actor_id)
  where invalidated_at is null;

create table admin_mfa_recovery_codes (
  id uuid primary key,
  code_set_id uuid not null
    references admin_mfa_recovery_code_sets(id) on delete cascade,
  actor_id text not null check (actor_id <> ''),
  code_hash bytea not null unique,
  created_at timestamptz not null,
  used_at timestamptz null,
  constraint admin_mfa_recovery_codes_used_check check (
    used_at is null or used_at >= created_at
  )
);

create index admin_mfa_recovery_codes_set_idx
  on admin_mfa_recovery_codes (code_set_id);

create index admin_mfa_recovery_codes_actor_used_idx
  on admin_mfa_recovery_codes (actor_id, used_at);
