/**
 * CX-006 / GT-ADS-003 (L-03, F-B04, F-A07): Typen für den deterministischen
 * fixed_slot-Schleifenplaner.
 *
 * Die Typen beschreiben ausschließlich explizite, bereits geprüfte Eingaben.
 * Es gibt keine Datenbankanbindung, keine automatische Platzbefüllung, keine
 * Gewichtung, Rotation, Exklusivität oder Wiederholung.
 */

import type { CampaignRuntimeError } from "../campaigns/runtimeWindow.js";

/** Zulässige Kampagnenzustände des vorhandenen Domänenmodells. */
export type LoopPlanCampaignStatus =
  | "draft"
  | "active"
  | "paused"
  | "finished"
  | "archived";

/**
 * Explizite Kampagnenbeschreibung für den Planer.
 *
 * targetTaxiIds und targetGroupIds bilden die direkte Taxi- beziehungsweise
 * Gruppenzuordnung ab. Eine Kampagne gilt als zugeordnet, sobald das Taxi
 * direkt oder über eine der übergebenen Gruppen genannt ist; mehrfache Treffer
 * erzeugen keine zusätzliche Belegung.
 */
export interface LoopPlanCampaign {
  campaignId: string;
  status: LoopPlanCampaignStatus;
  startAt: string;
  endAt: string;
  targetTaxiIds: readonly string[];
  targetGroupIds: readonly string[];
}

/** Geprüfte Medienreferenz, wie sie aus CX-003/CX-005 hervorgeht. */
export interface LoopPlanMedia {
  mediaId: string;
  /** SHA-256 als 64 kleingeschriebene Hexzeichen (CX-005). */
  sha256: string;
  sizeBytes: number;
  durationMs: number;
}

/** Eine ausdrücklich gelieferte Platzbelegung. */
export interface LoopPlanPlacement {
  /** Lückenlose Position 1 bis slotCount. */
  position: number;
  campaignId: string;
  media: LoopPlanMedia;
}

/** Explizite Eingabe des Schleifenplaners. */
export interface LoopPlanInput {
  taxiId: string;
  groupIds: readonly string[];
  /** Ganzzahlig zwischen 12 und 16; es gibt keinen Standardwert. */
  slotCount: number;
  campaigns: readonly LoopPlanCampaign[];
  placements: readonly LoopPlanPlacement[];
}

/** Ein geordneter Spot des erzeugten Schleifenplans. */
export interface LoopPlanSpot {
  position: number;
  campaignId: string;
  mediaId: string;
  sha256: string;
  sizeBytes: number;
  durationMs: number;
  /** Unverändert übernommener UTC-Start aus der Kampagne (CX-004). */
  startAt: string;
  /** Unverändert übernommenes UTC-Ende aus der Kampagne (CX-004). */
  endAt: string;
}

/** Deterministisches Ergebnis des Schleifenplaners. */
export interface LoopPlan {
  taxiId: string;
  slotCount: number;
  loopDurationMs: number;
  spots: LoopPlanSpot[];
}

/** Stabile Fehlercodes des Schleifenplaners. */
export type LoopPlanErrorCode =
  | "invalid_taxi_id"
  | "invalid_group_ids"
  | "invalid_slot_count"
  | "invalid_campaign"
  | "invalid_position"
  | "duplicate_position"
  | "missing_position"
  | "unknown_campaign"
  | "campaign_not_active"
  | "not_assigned"
  | "invalid_media"
  | "invalid_spot_duration"
  | "invalid_runtime_window";

/** Zusätzliche, maschinenlesbare Fehlerdetails. */
export interface LoopPlanErrorDetails {
  field?: string;
  position?: number;
  campaignId?: string;
  missingPositions?: number[];
  runtimeErrors?: CampaignRuntimeError[];
}

/** Typisierter interner Fehler für unvollständige oder widersprüchliche Eingaben. */
export class LoopPlanError extends Error {
  readonly code: LoopPlanErrorCode;
  readonly details: LoopPlanErrorDetails;

  constructor(
    code: LoopPlanErrorCode,
    message: string,
    details: LoopPlanErrorDetails = {},
  ) {
    super(message);
    this.name = "LoopPlanError";
    this.code = code;
    this.details = details;
  }
}
