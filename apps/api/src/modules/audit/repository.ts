import type { Pool } from "pg";
import { isSensitiveFieldName } from "../../http/logging.js";

/** Minimale SQL-Schnittstelle, die pg.Pool und pg.PoolClient erfuellen. */
export type SqlQueryable = Pick<Pool, "query">;

export type AuditActorType = "admin" | "device" | "system";

/**
 * Aktionen laut AC-13 sowie die spaeter registrierten Verwaltungsaktionen.
 * Namen sind stabil und werden in Tests geprueft.
 */
export const AUDIT_ACTIONS = Object.freeze({
  registrationCodeCreated: "registration_code.created",
  registrationCodeUsed: "registration_code.used",
  registrationCodeRevoked: "registration_code.revoked",
  deviceRegistered: "device.registered",
  deviceRevoked: "device.revoked",
  adminLoginSucceeded: "admin.login.succeeded",
  adminLoginFailed: "admin.login.failed",
  operatorCreated: "operator.created",
  operatorDisabled: "operator.disabled",
  customerCreated: "customer.created",
  campaignCreated: "campaign.created",
  campaignUpdated: "campaign.updated",
  campaignTransitioned: "campaign.transitioned",
  mediaCreated: "media.created",
  mediaDeleted: "media.deleted",
  taxiGroupCreated: "taxi_group.created",
  taxiGroupRenamed: "taxi_group.renamed",
  taxiGroupMembershipsReplaced: "taxi.group_memberships_replaced",
  taxiCreated: "taxi.created",
  taxiUpdated: "taxi.updated",
  taxiActivationChanged: "taxi.activation.changed",
  tabletActivationChanged: "tablet.activation.changed",
  remoteControlPauseSet: "remote_control.pause.set",
  controlConfigUpdated: "control_config.taxi.update",
  inventoryUpdated: "device.inventory.updated",
  appReleaseCreated: "app_release.created",
  appReleaseRolloutChanged: "app_release.rollout.changed",
  deviceUpdateChannelChanged: "device.update_channel.changed",
});

/**
 * Zuordnung der tatsaechlich registrierten menschlichen Schreibrouten zu dem
 * Audit-Ereignis, das die jeweilige Fachaenderung begleitet. Der Katalog
 * enthaelt bewusst keine HTTP-Hooks: die Module schreiben Audit weiterhin in
 * ihrer eigenen Fachtransaktion.
 *
 * POST /v1/admin/logout ist eine Sitzungsaktion und kein Aenderungserfolg; die
 * Route steht deshalb in AUDIT_WRITE_ROUTE_EXEMPTIONS.
 */
export const AUDIT_WRITE_ROUTE_ACTIONS: Readonly<Record<string, string>> =
  Object.freeze({
    "POST /v1/admin/operators": AUDIT_ACTIONS.operatorCreated,
    "POST /v1/admin/operators/:operatorId/disable":
      AUDIT_ACTIONS.operatorDisabled,
    "POST /v1/admin/registration-codes": AUDIT_ACTIONS.registrationCodeCreated,
    "DELETE /v1/admin/registration-codes/:id":
      AUDIT_ACTIONS.registrationCodeRevoked,
    "POST /v1/admin/devices/:id/revoke": AUDIT_ACTIONS.deviceRevoked,
    "POST /v1/admin/customers": AUDIT_ACTIONS.customerCreated,
    "POST /v1/admin/campaigns": AUDIT_ACTIONS.campaignCreated,
    "PATCH /v1/admin/campaigns/:id": AUDIT_ACTIONS.campaignUpdated,
    "PATCH /v1/admin/taxis/:taxiId/config": AUDIT_ACTIONS.controlConfigUpdated,
    "POST /v1/admin/taxi-groups": AUDIT_ACTIONS.taxiGroupCreated,
    "PATCH /v1/admin/taxi-groups/:id": AUDIT_ACTIONS.taxiGroupRenamed,
    "POST /v1/admin/taxis": AUDIT_ACTIONS.taxiCreated,
    "PATCH /v1/admin/taxis/:id": AUDIT_ACTIONS.taxiUpdated,
    "PUT /v1/admin/taxis/:id/groups":
      AUDIT_ACTIONS.taxiGroupMembershipsReplaced,
    "POST /v1/admin/taxis/:taxiId/activation":
      AUDIT_ACTIONS.taxiActivationChanged,
    "PATCH /v1/admin/tablets/:tabletId/activation":
      AUDIT_ACTIONS.tabletActivationChanged,
    "POST /v1/admin/taxis/:taxi_id/pause": AUDIT_ACTIONS.remoteControlPauseSet,
    "POST /v1/admin/taxis/:taxi_id/resume": AUDIT_ACTIONS.remoteControlPauseSet,
    "PATCH /v1/admin/inventory/:tabletId": AUDIT_ACTIONS.inventoryUpdated,
    "POST /v1/admin/media": AUDIT_ACTIONS.mediaCreated,
    "POST /v1/admin/app-releases": AUDIT_ACTIONS.appReleaseCreated,
    "PATCH /v1/admin/app-releases/:id": AUDIT_ACTIONS.appReleaseRolloutChanged,
    "PATCH /v1/admin/devices/:id/update-channel":
      AUDIT_ACTIONS.deviceUpdateChannelChanged,
  });

/** Menschliche Schreibrouten ohne Aenderungsaudit (reine Sitzungsaktion). */
export const AUDIT_WRITE_ROUTE_EXEMPTIONS: ReadonlySet<string> = new Set([
  "POST /v1/admin/logout",
]);

/** Liefert den Audit-Aktionsnamen einer menschlichen Schreibrouten-Vorlage. */
export function auditActionForWriteRoute(
  method: string,
  template: string,
): string | undefined {
  return AUDIT_WRITE_ROUTE_ACTIONS[method.toUpperCase() + " " + template];
}

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
