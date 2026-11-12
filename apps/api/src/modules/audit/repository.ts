import type { Pool } from "pg";
import { isSensitiveFieldName } from "../../http/logging.js";

/** Minimale SQL-Schnittstelle, die pg.Pool und pg.PoolClient erfuellen. */
export type SqlQueryable = Pick<Pool, "query">;

export type AuditActorType = "admin" | "device" | "system";

/** Aktionen laut AC-13. Namen sind stabil und werden in Tests geprueft. */
export const AUDIT_ACTIONS = Object.freeze({
  registrationCodeCreated: "registration_code.created",
  registrationCodeUsed: "registration_code.used",
  registrationCodeRevoked: "registration_code.revoked",
  deviceRegistered: "device.registered",
  deviceRevoked: "device.revoked",
  adminLoginSucceeded: "admin.login.succeeded",
  adminLoginFailed: "admin.login.failed",
});

export interface AuditEventInput {
  at: Date;
  actorType: AuditActorType;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown>;
}

export interface AuditEventRow {
  id: string;
  at: Date;
  actor_type: AuditActorType;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
}

/**
 * Audit-Details werden ausschliesslich vom Service gebaut. Diese Pruefung
 * verhindert zusaetzlich, dass ein geheimer Feldname (Code, Token, Nonce,
 * Signatur, Passwort, oeffentlicher Schluessel) durchrutscht (AC-05/AC-13).
 */
export function assertNoSensitiveDetails(details: Record<string, unknown>): void {
  for (const key of Object.keys(details)) {
    if (isSensitiveFieldName(key)) {
      throw new Error(
        "Audit-Details duerfen das Feld " + key + " nicht enthalten",
      );
    }
  }
}

/** Schreibt einen Audit-Eintrag ueber den uebergebenen Executor. */
export async function insertAuditEvent(
  executor: SqlQueryable,
  event: AuditEventInput,
): Promise<void> {
  const details = event.details ?? {};
  assertNoSensitiveDetails(details);
  await executor.query(
    [
      "insert into audit_events",
      "  (at, actor_type, actor_id, action, target_type, target_id, details)",
      "values ($1, $2, $3, $4, $5, $6, $7)",
    ].join("\n"),
    [
      event.at,
      event.actorType,
      event.actorId ?? null,
      event.action,
      event.targetType ?? null,
      event.targetId ?? null,
      details,
    ],
  );
}

/** Liest Audit-Eintraege, neueste zuerst. Nur fuer Tests und Admin-Sicht. */
export async function listAuditEvents(
  executor: SqlQueryable,
): Promise<AuditEventRow[]> {
  const result = await executor.query<AuditEventRow>(
    [
      "select id::text as id, at, actor_type, actor_id, action,",
      "       target_type, target_id, details",
      "  from audit_events",
      " order by id desc",
    ].join("\n"),
  );
  return result.rows;
}
