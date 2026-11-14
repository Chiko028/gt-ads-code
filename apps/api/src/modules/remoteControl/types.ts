import type { Pool, PoolClient } from "pg";
import type { AuditEventInput, SqlQueryable } from "../audit/repository.js";
import type { RemoteControlOrigin } from "./canonical.js";
import type { TaxiDirectory } from "./taxiDirectory.js";

/** Minimale SQL-Schnittstellen; pg.Pool und pg.PoolClient erfuellen sie. */
export type RemoteControlSqlClient = Pick<PoolClient, "query">;
export type RemoteControlSqlPool = Pick<Pool, "connect">;

/** Standard ist der bestehende Audit-Schreibweg; Tests duerfen ihn ersetzen. */
export type RemoteControlAuditWriter = (
  executor: SqlQueryable,
  event: AuditEventInput,
) => Promise<void>;

export interface SetDesiredPauseInput {
  /** Authentifizierter Akteur aus dem aufrufenden Kontext. */
  actor: { id: string; type?: "admin" };
  taxiId: string;
  commandId: string;
  expectedRevision: number;
  desiredPaused: boolean;
  /** Request-ID des ausloesenden HTTP-Aufrufs; nur fuer den Audit-Datensatz. */
  requestId?: string;
}

export interface SetDesiredPauseResult {
  commandId: string;
  taxiId: string;
  revision: number;
  desiredPaused: boolean;
  origin: RemoteControlOrigin;
  targetDeviceIds: string[];
  /** Wahr, wenn dieselbe command_id unveraendert wiederholt wurde. */
  idempotent: boolean;
}

export interface PendingCommand {
  commandId: string;
  taxiId: string;
  revision: number;
  desiredPaused: boolean;
  origin: RemoteControlOrigin;
  issuedAt: Date;
}

export interface AcknowledgeAppliedInput {
  /** Geraet aus dem authentifizierten Geraetekontext. */
  deviceId: string;
  taxiId: string;
  revision: number;
}

export interface AcknowledgeAppliedResult {
  deviceId: string;
  taxiId: string;
  commandId: string;
  revision: number;
  status: "applied";
  /** Wahr, wenn die Bestaetigung bereits vorhanden war (keine Mutation). */
  duplicate: boolean;
}

export interface RemoteControlServiceOptions {
  pool: RemoteControlSqlPool;
  directory: TaxiDirectory;
  now?: () => Date;
  auditWriter?: RemoteControlAuditWriter;
}
