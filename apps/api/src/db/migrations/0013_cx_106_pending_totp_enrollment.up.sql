-- CX-106 / R-605: ausstehende TOTP-Einrichtung je Admin.
-- Additiv: genau ein Datensatz je Admin, kein Klartextgeheimnis, keine
-- Loeschoperation und keine Aktivierung. Die Einrichtung ist an die
-- kanonische actor_id gebunden und nach expires_at nicht mehr nutzbar.

create table admin_mfa_pending_totp_enrollments (
  actor_id text primary key check (actor_id <> ''),
  enrollment_id uuid not null unique,
  expires_at timestamptz not null,
  nonce bytea not null check (octet_length(nonce) = 12),
  ciphertext bytea not null check (octet_length(ciphertext) > 0),
  tag bytea not null check (octet_length(tag) = 16)
);
