-- CX-101 / R-204 (Teil 2): Kampagnenentwurf als additive Tabelle.
-- Die Tabelle ist die einzige Kampagnenpersistenz. Kunden, Medien,
-- Betreiber- und Auditdaten bleiben unveraendert; es entstehen keine
-- parallelen Stammdatentabellen. Das Medium wird bewusst nicht per
-- Fremdschluessel gebunden, weil vorhandene, bereits geloeschte Medien
-- historische Kampagnen nicht ungueltig machen duerfen. saveCampaignDraft
-- (modules/campaigns/drafts.ts) prueft Kunde, Mediumsstatus und
-- Loeschmarkierung sowie die Laufzeit vor dem transaktionsgebundenen
-- Einfuegen samt bereinigtem U3-Audit.

create table if not exists campaigns (
  id uuid primary key,
  customer_id uuid not null references customers(id),
  media_id uuid not null,
  owner_id text not null,
  rule_type text not null,
  status text not null,
  archived boolean not null default false,
  start_at timestamptz not null,
  end_at timestamptz not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaigns_rule_type_fixed_slot check (rule_type = 'fixed_slot'),
  constraint campaigns_status_known check
    (status in ('draft', 'active', 'paused', 'finished')),
  constraint campaigns_runtime_order check (end_at > start_at),
  constraint campaigns_revision_positive check (revision >= 1)
);

create index if not exists campaigns_owner_idx on campaigns (owner_id);
