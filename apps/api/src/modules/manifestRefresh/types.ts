/**
 * CX-041 / R-301: Typen der duennen Manifest-Neuberechnungs-Orchestrierung.
 *
 * Der Dienst baut ausschliesslich vorhandene Fachfunktionen zusammen:
 * CX-024 prueft Belegungen, CX-025 plant, CX-007 signiert und prueft. Eigene
 * Planungs-, Signatur- oder Belegungsregeln existieren hier nicht.
 */
import type { KeyObject } from "node:crypto";
import type { Pool } from "pg";
import type {
  CreateSignedManifestInput,
  ManifestEnvironment,
  SignedManifestEnvelope,
  VerifiedManifest,
  VerifySignedManifestExpectations,
} from "../playout/manifest.js";
import type { LoopPlan as BuiltLoopPlan } from "../playout/planner.js";

/** Ein von einer Mutation ausgeloester, begrenzter Lauf. */
export interface ManifestRefreshTrigger {
  drainPending(options?: { limit?: number }): Promise<DrainResult>;
}

/** Explizit injizierbarer Planer-Port; Standard ist CX-025. */
export type ManifestPlanner = (input: unknown) => BuiltLoopPlan;

/** Explizit injizierbarer Signier-Port; Standard ist CX-007. */
export type ManifestSigner = (
  input: CreateSignedManifestInput,
) => SignedManifestEnvelope;

/** Explizit injizierbarer Pruef-Port; Standard ist CX-007. */
export type ManifestVerifier = (
  envelope: unknown,
  expectations: VerifySignedManifestExpectations,
) => VerifiedManifest;

export interface ManifestRefreshOptions {
  pool: Pool;
  signingKey: KeyObject;
  keyId: string;
  environment: ManifestEnvironment;
  trustedKeys: ReadonlyMap<string, KeyObject>;
  now?: () => Date;
  /** Feste Schleifengroesse 12 bis 16; kein neuer Standardwert. */
  slotCount?: number;
  /**
   * Optionales, bereits ueber CX-030/031 gespeichertes GT-Ads-Platzhaltermedium
   * (R-305). null oder undefined bedeutet "nicht konfiguriert".
   */
  fallbackMediaId?: string | null;
  /** Obergrenze eines Aufrufs ohne explizite Grenze. */
  defaultLimit?: number;
  planner?: ManifestPlanner;
  signer?: ManifestSigner;
  verifier?: ManifestVerifier;
}

export type ManifestRefreshStatus = "published" | "skipped" | "failed";

export interface ManifestRefreshItemResult {
  taxiId: string;
  status: ManifestRefreshStatus;
  requestedRevision: number;
  processedRevision: number;
  version?: string;
  error?: string;
}

export interface DrainResult {
  scanned: number;
  published: number;
  skipped: number;
  failed: number;
  items: ManifestRefreshItemResult[];
}

export interface ManifestRefreshState {
  taxiId: string;
  requestedRevision: number;
  processedRevision: number;
  currentVersion: string | null;
  currentRevision: number | null;
  lastError: string | null;
  updatedAt: Date;
}

export interface ManifestArtifactRecord {
  taxiId: string;
  version: string;
  keyId: string;
  environment: ManifestEnvironment;
  payloadBase64: string;
  signatureBase64: string;
  sourceRevision: number;
  createdAt: Date;
  envelope: SignedManifestEnvelope;
}
