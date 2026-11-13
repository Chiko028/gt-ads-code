/**
 * CX-038 / R-205: additives Kampagnenschema.
 *
 * Der Integrationsstand enthaelt keine Kampagnentabelle (CX-032 hat sie
 * bewusst ausgelassen). Dieses Modul legt deshalb die einzige Kampagnen-
 * persistenz idempotent an. Es entsteht keine Migrationsdatei und keine
 * Aenderung an bestehenden Vertraegen; die Tabellen sind rein additiv.
 */
import type { SqlQueryable } from "../audit/repository.js";

const SCHEMA_SQL = [
  "create table if not exists campaigns (",
  "  id uuid primary key,",
  "  customer_id uuid not null references customers(id),",
  "  media_id uuid not null,",
  "  owner_id text not null,",
  "  rule_type text not null,",
  "  status text not null,",
  "  archived boolean not null default false,",
  "  start_at timestamptz not null,",
  "  end_at timestamptz not null,",
  "  revision integer not null default 1,",
  "  created_at timestamptz not null default now(),",
  "  updated_at timestamptz not null default now(),",
  "  constraint campaigns_rule_type_fixed_slot check (rule_type = 'fixed_slot'),",
  "  constraint campaigns_status_known check",
  "    (status in ('draft', 'active', 'paused', 'finished')),",
  "  constraint campaigns_runtime_order check (end_at > start_at),",
  "  constraint campaigns_revision_positive check (revision >= 1)",
  ");",
  "create table if not exists campaign_targets (",
  "  campaign_id uuid not null references campaigns(id) on delete cascade,",
  "  kind text not null,",
  "  target_id text not null,",
  "  primary key (campaign_id, kind, target_id),",
  "  constraint campaign_targets_kind_known check (kind in ('taxi', 'group')),",
  "  constraint campaign_targets_id_length check",
  "    (char_length(target_id) between 1 and 128)",
  ");",
  "create index if not exists campaigns_owner_idx on campaigns (owner_id);",
].join("\n");

/** Legt das additive Schema an; mehrfacher Aufruf ist folgenlos. */
export async function ensureCampaignSchema(pool: SqlQueryable): Promise<void> {
  await pool.query(SCHEMA_SQL);
}

