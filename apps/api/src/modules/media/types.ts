import type { Pool } from "pg";
import type {
  AuditActorType,
  AuditEventInput,
  SqlQueryable,
} from "../audit/repository.js";
import type { MediaProfileInput } from "./profile.js";
import type { ManifestRefreshTrigger } from "../manifestRefresh/index.js";

/** Stabiler Auditname laut R-201/CX-030. */
export const MEDIA_CREATED_ACTION = "media.created";
/** Stabiler Auditname der logischen Loeschung laut R-203/CX-078. */
export const MEDIA_DELETED_ACTION = "media.deleted";
export const MEDIA_AUDIT_TARGET_TYPE = "media";

export const MEDIA_MAX_LIST_LIMIT = 100;
export const MEDIA_DEFAULT_LIST_LIMIT = 50;

export type MediaSqlPool = Pick<Pool, "query" | "connect">;

/**
 * Transaktionsgebundener Audit-Port aus U3. Der Service uebergibt den
 * Client der laufenden Transaktion, damit Fachzustand und Audit gemeinsam
 * committen oder zurueckrollen.
 */
export type MediaAuditWriter = (
  executor: SqlQueryable,
  event: AuditEventInput,
) => Promise<void>;

/** Persistierte, gepruefte Profilmetadaten. */
export interface MediaProfileMetadata {
  container: string;
  videoCodec: string;
  width: number;
  height: number;
  frameRateNumerator: number;
  frameRateDenominator: number;
  audioStreamCount: number;
  durationSeconds: number;
}

/** Oeffentliche Metadaten eines bereitgestellten Mediums. */
export interface MediaMetadata {
  id: string;
  displayName: string;
  sizeBytes: number;
  sha256: string;
  profile: MediaProfileMetadata;
  createdAt: Date;
  status: "ready";
}

/**
 * Bereitgestelltes Medium. Der Lesezugriff leitet den Pfad ausschliesslich
 * aus der serverseitigen ID ab; der Anzeigename ist niemals ein Pfad.
 */
export interface ReadyMedia extends MediaMetadata {
  read(): Promise<Buffer>;
}

export interface MediaListPage {
  items: MediaMetadata[];
  nextCursor: string | null;
}

/**
 * Ergebnis der logischen Loeschung. alreadyDeleted kennzeichnet den
 * idempotenten Wiederholungsfall: Es wurde kein zweites Audit geschrieben
 * und deletedAt bleibt der urspruengliche Zeitpunkt.
 */
export interface MediaDeletionResult {
  id: string;
  deletedAt: Date;
  alreadyDeleted: boolean;
}

export interface DeleteMediaOptions {
  actorType?: AuditActorType;
  actorId?: string | null;
}

export interface ListReadyMediaQuery {
  limit?: number;
  cursor?: string | null;
}

export interface CreateMediaInput {
  /** Nur begrenzte Anzeigebezeichnung, kein Pfad. */
  displayName: string;
  /** Vom Aufrufer bereitgestellte Uploadbytes. */
  content: AsyncIterable<Uint8Array>;
  /**
   * Ergebnis eines vertrauenswuerdigen serverseitigen Medienlesers. Die
   * Bytezahl wird ignoriert und aus den tatsaechlichen Bytes neu bestimmt.
   */
  metadata: unknown;
  actorType?: AuditActorType;
  actorId?: string | null;
}

export interface MediaServiceOptions {
  pool: MediaSqlPool;
  /** Explizit injiziertes lokales Stammverzeichnis, kein Default. */
  storageRoot: string;
  now?: () => Date;
  /** Nur fuer deterministische Tests; Standard ist randomUUID(). */
  idFactory?: () => string;
  /**
   * U3-Audit-Port. Ohne Angabe wird der vorhandene insertAuditEvent-Writer
   * verwendet; beide schreiben auf den Transaktionsclient.
   */
  auditWriter?: MediaAuditWriter;
  manifestRefresh?: ManifestRefreshTrigger;
}

export interface MediaRecoveryResult {
  completed: number;
  cleaned: number;
  failed: number;
}

/** Eingabe fuer die Profilpruefung; die Bytezahl stammt aus CX-005. */
export type MediaProfileCandidate = MediaProfileInput;
