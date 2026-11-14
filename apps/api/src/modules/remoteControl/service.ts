import {
  insertAuditEvent,
  type AuditEventInput,
} from "../audit/repository.js";
import {
  commandContentFingerprint,
  REMOTE_CONTROL_ORIGIN,
  type RemoteControlOrigin,
} from "./canonical.js";
import {
  RemoteControlAckRejectedError,
  RemoteControlCommandConflictError,
  RemoteControlDeviceRejectedError,
  RemoteControlError,
  RemoteControlRevisionConflictError,
  RemoteControlTaxiTargetError,
  RemoteControlValidationError,
} from "./errors.js";
import {
  INSERT_COMMAND_SQL,
  INSERT_DELIVERY_SQL,
  INSERT_TAXI_STATE_SQL,
  LOCK_TAXI_STATE_SQL,
  SELECT_COMMAND_DEVICES_SQL,
  SELECT_COMMAND_SQL,
  SELECT_DELIVERY_FOR_ACK_SQL,
  SELECT_DEVICE_SQL,
  SELECT_PENDING_SQL,
  SELECT_TAXI_DEVICES_SQL,
  SUPERSEDE_PENDING_SQL,
  UPDATE_DELIVERY_APPLIED_SQL,
  UPDATE_TAXI_STATE_SQL,
  type CommandRow,
  type DeliveryRow,
  type DeviceStateRow,
  type PendingRow,
  type TaxiStateRow,
} from "./repository.js";
import type {
  AcknowledgeAppliedInput,
  AcknowledgeAppliedResult,
  PendingCommand,
  RemoteControlAuditWriter,
  RemoteControlServiceOptions,
  RemoteControlSqlClient,
  SetDesiredPauseInput,
  SetDesiredPauseResult,
} from "./types.js";
import {
  normalizeAcknowledgeAppliedInput,
  normalizeSetDesiredPauseInput,
  requireUuid,
} from "./validation.js";

/** Stabiler Audit-Aktionsname dieses Pakets. */
export const REMOTE_CONTROL_AUDIT_ACTION = "remote_control.pause.set";

function readRevision(value: string | undefined): number {
  const revision = value === undefined ? Number.NaN : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new RemoteControlError("Ungueltige gespeicherte Revision.");
  }
  return revision;
}

function readOrigin(value: string): RemoteControlOrigin {
  if (value !== REMOTE_CONTROL_ORIGIN) {
    throw new RemoteControlError("Ungueltiger gespeicherter Ursprung.");
  }
  return REMOTE_CONTROL_ORIGIN;
}

/**
 * Persistenter Kern fuer taxiweite Pause-/Fortsetzen-Sollzustaende.
 *
 * - Idempotenz ueber command_id wird vor expected_revision geprueft.
 * - Konkurrierende Aenderungen werden ueber die Zustandszeile des Taxis
 *   serialisiert; genau eine Aenderung je erwarteter Revision gewinnt.
 * - Auftrag, Zielgeraete, Revision und Audit entstehen in einer Transaktion.
 * - Bestaetigungen gelten nur fuer das authentifizierte, aktive, dem Taxi
 *   zugeordnete Geraet und exakt die angebotene Revision.
 */
export class RemoteControlService {
  private readonly pool: RemoteControlServiceOptions["pool"];
  private readonly directory: RemoteControlServiceOptions["directory"];
  private readonly now: () => Date;
  private readonly auditWriter: RemoteControlAuditWriter | undefined;

  constructor(options: RemoteControlServiceOptions) {
    this.pool = options.pool;
    this.directory = options.directory;
    this.now = options.now ?? (() => new Date());
    this.auditWriter = options.auditWriter;
  }

  private async writeAudit(
    client: RemoteControlSqlClient,
    event: AuditEventInput,
  ): Promise<void> {
    if (this.auditWriter !== undefined) {
      await this.auditWriter(client, event);
      return;
    }
    await insertAuditEvent(client, event);
  }

  async setDesiredPause(
    input: SetDesiredPauseInput,
  ): Promise<SetDesiredPauseResult> {
    const normalized = normalizeSetDesiredPauseInput(input);
    const issuedAt = this.now();
    if (!(issuedAt instanceof Date) || Number.isNaN(issuedAt.getTime())) {
      throw new RemoteControlValidationError(
        "Die injizierte Serveruhr liefert keinen gueltigen Zeitpunkt.",
      );
    }

    const origin = REMOTE_CONTROL_ORIGIN;
    const fingerprint = commandContentFingerprint({
      taxiId: normalized.taxiId,
      desiredPaused: normalized.desiredPaused,
      origin,
    });

    const client = await this.pool.connect();
    let inTransaction = false;
    try {
      await client.query("begin");
      inTransaction = true;

      // Erste Aenderung legt die Zustandszeile an; danach serialisiert die
      // Zeilensperre alle konkurrierenden Aenderungen desselben Taxis.
      await client.query(INSERT_TAXI_STATE_SQL, [normalized.taxiId, issuedAt]);
      const state = await client.query<TaxiStateRow>(LOCK_TAXI_STATE_SQL, [
        normalized.taxiId,
      ]);
      const currentRevision = readRevision(state.rows[0]?.revision);

      // Idempotenz strikt vor der Revisionspruefung.
      const existing = await client.query<CommandRow>(SELECT_COMMAND_SQL, [
        normalized.commandId,
      ]);
      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.content_fingerprint !== fingerprint) {
          throw new RemoteControlCommandConflictError(normalized.commandId);
        }
        const deliveries = await client.query<{ device_id: string }>(
          SELECT_COMMAND_DEVICES_SQL,
          [normalized.commandId],
        );
        await client.query("commit");
        inTransaction = false;
        return {
          commandId: row.command_id,
          taxiId: row.taxi_id,
          revision: readRevision(row.revision),
          desiredPaused: row.desired_paused,
          origin: readOrigin(row.origin),
          targetDeviceIds: deliveries.rows.map((delivery) => delivery.device_id),
          idempotent: true,
        };
      }

      if (normalized.expectedRevision !== currentRevision) {
        throw new RemoteControlRevisionConflictError(
          normalized.expectedRevision,
          currentRevision,
        );
      }

      const targetDeviceIds = await this.resolveTargets(
        client,
        normalized.taxiId,
      );
      const revision = currentRevision + 1;

      // Aeltere ausstehende Zustellungen werden ersetzt, ihre Historie bleibt.
      await client.query(SUPERSEDE_PENDING_SQL, [normalized.taxiId, issuedAt]);
      await client.query(INSERT_COMMAND_SQL, [
        normalized.commandId,
        normalized.taxiId,
        revision,
        normalized.desiredPaused,
        origin,
        normalized.actorId,
        fingerprint,
        issuedAt,
      ]);
      await client.query(UPDATE_TAXI_STATE_SQL, [
        normalized.taxiId,
        revision,
        normalized.desiredPaused,
        issuedAt,
      ]);
      for (const deviceId of targetDeviceIds) {
        await client.query(INSERT_DELIVERY_SQL, [
          normalized.commandId,
          normalized.taxiId,
          deviceId,
          revision,
          issuedAt,
        ]);
      }

      await this.writeAudit(client, {
        at: issuedAt,
        actorType: "admin",
        actorId: normalized.actorId,
        action: REMOTE_CONTROL_AUDIT_ACTION,
        targetType: "taxi",
        targetId: normalized.taxiId,
        details: {
          command_id: normalized.commandId,
          revision,
          expected_revision: normalized.expectedRevision,
          desired_paused: normalized.desiredPaused,
          origin,
          target_device_ids: targetDeviceIds,
          request_id: normalized.requestId ?? null,
        },
      });

      await client.query("commit");
      inTransaction = false;
      return {
        commandId: normalized.commandId,
        taxiId: normalized.taxiId,
        revision,
        desiredPaused: normalized.desiredPaused,
        origin,
        targetDeviceIds,
        idempotent: false,
      };
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query("rollback");
        } catch {
          // Der urspruengliche Fehler bleibt massgeblich.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getPendingForDevice(deviceId: string): Promise<PendingCommand | null> {
    const normalizedDeviceId = requireUuid(deviceId, "deviceId");
    const client = await this.pool.connect();
    try {
      const assignment = await this.directory.findDeviceAssignment(
        normalizedDeviceId,
      );
      if (assignment === null) {
        throw new RemoteControlDeviceRejectedError(
          normalizedDeviceId,
          "not_assigned",
        );
      }
      if (!assignment.active) {
        throw new RemoteControlDeviceRejectedError(
          normalizedDeviceId,
          "inactive",
        );
      }
      const device = await client.query<DeviceStateRow>(SELECT_DEVICE_SQL, [
        normalizedDeviceId,
      ]);
      if (device.rows.length === 0 || device.rows[0].state !== "active") {
        throw new RemoteControlDeviceRejectedError(
          normalizedDeviceId,
          "revoked",
        );
      }

      const result = await client.query<PendingRow>(SELECT_PENDING_SQL, [
        normalizedDeviceId,
        assignment.taxiId,
      ]);
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        commandId: row.command_id,
        taxiId: row.taxi_id,
        revision: readRevision(row.revision),
        desiredPaused: row.desired_paused,
        origin: readOrigin(row.origin),
        issuedAt: new Date(row.issued_at),
      };
    } finally {
      client.release();
    }
  }

  async acknowledgeApplied(
    input: AcknowledgeAppliedInput,
  ): Promise<AcknowledgeAppliedResult> {
    const normalized = normalizeAcknowledgeAppliedInput(input);
    const acknowledgedAt = this.now();
    if (
      !(acknowledgedAt instanceof Date) ||
      Number.isNaN(acknowledgedAt.getTime())
    ) {
      throw new RemoteControlValidationError(
        "Die injizierte Serveruhr liefert keinen gueltigen Zeitpunkt.",
      );
    }

    const client = await this.pool.connect();
    let inTransaction = false;
    try {
      await client.query("begin");
      inTransaction = true;

      await this.assertDeviceEligible(
        client,
        normalized.deviceId,
        normalized.taxiId,
      );

      const result = await client.query<DeliveryRow>(
        SELECT_DELIVERY_FOR_ACK_SQL,
        [normalized.deviceId, normalized.taxiId, normalized.revision],
      );
      const delivery = result.rows[0];
      if (delivery === undefined) {
        throw new RemoteControlAckRejectedError(
          normalized.deviceId,
          normalized.taxiId,
          normalized.revision,
          "unknown_revision",
        );
      }
      if (delivery.status === "superseded") {
        throw new RemoteControlAckRejectedError(
          normalized.deviceId,
          normalized.taxiId,
          normalized.revision,
          "superseded",
        );
      }
      if (delivery.status === "applied") {
        await client.query("commit");
        inTransaction = false;
        return {
          deviceId: normalized.deviceId,
          taxiId: normalized.taxiId,
          commandId: delivery.command_id,
          revision: readRevision(delivery.revision),
          status: "applied",
          duplicate: true,
        };
      }

      const updated = await client.query<{ id: string }>(
        UPDATE_DELIVERY_APPLIED_SQL,
        [delivery.id, acknowledgedAt],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        throw new RemoteControlAckRejectedError(
          normalized.deviceId,
          normalized.taxiId,
          normalized.revision,
          "unknown_revision",
        );
      }

      await client.query("commit");
      inTransaction = false;
      return {
        deviceId: normalized.deviceId,
        taxiId: normalized.taxiId,
        commandId: delivery.command_id,
        revision: readRevision(delivery.revision),
        status: "applied",
        duplicate: false,
      };
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query("rollback");
        } catch {
          // Der urspruengliche Fehler bleibt massgeblich.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async resolveTargets(
    client: RemoteControlSqlClient,
    taxiId: string,
  ): Promise<string[]> {
    const raw = await this.directory.listActiveDeviceIds(taxiId);
    const unique = new Set<string>();
    for (const candidate of raw) {
      unique.add(requireUuid(candidate, "deviceId"));
    }
    if (unique.size !== 2) {
      throw new RemoteControlTaxiTargetError(taxiId, unique.size);
    }
    const targetDeviceIds = [...unique].sort();
    const rows = await client.query<DeviceStateRow>(SELECT_TAXI_DEVICES_SQL, [
      targetDeviceIds,
    ]);
    const activeCount = rows.rows.filter(
      (device) => device.state === "active",
    ).length;
    if (rows.rows.length !== 2 || activeCount !== 2) {
      throw new RemoteControlTaxiTargetError(taxiId, activeCount);
    }
    return targetDeviceIds;
  }

  private async assertDeviceEligible(
    client: RemoteControlSqlClient,
    deviceId: string,
    taxiId: string,
  ): Promise<void> {
    const assignment = await this.directory.findDeviceAssignment(deviceId);
    if (assignment === null || assignment.taxiId !== taxiId) {
      throw new RemoteControlDeviceRejectedError(deviceId, "not_assigned");
    }
    if (!assignment.active) {
      throw new RemoteControlDeviceRejectedError(deviceId, "inactive");
    }
    const device = await client.query<DeviceStateRow>(SELECT_DEVICE_SQL, [
      deviceId,
    ]);
    if (device.rows.length === 0 || device.rows[0].state !== "active") {
      throw new RemoteControlDeviceRejectedError(deviceId, "revoked");
    }
  }
}

export function createRemoteControlService(
  options: RemoteControlServiceOptions,
): RemoteControlService {
  return new RemoteControlService(options);
}
