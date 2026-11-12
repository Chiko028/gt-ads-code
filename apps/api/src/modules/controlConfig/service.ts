import { createHash } from "node:crypto";
import {
  insertAuditEvent,
  type AuditEventInput,
} from "../audit/repository.js";
import {
  ControlConfigChangeConflictError,
  ControlConfigError,
  ControlConfigRevisionConflictError,
} from "./errors.js";
import {
  INSERT_CHANGE_SQL,
  INSERT_DEFAULT_CONFIG_SQL,
  LOCK_CONFIG_SQL,
  SELECT_CHANGE_SQL,
  SELECT_CONFIG_SQL,
  UPDATE_CONFIG_SQL,
  type ControlConfigChangeRow,
  type ControlConfigRow,
} from "./repository.js";
import type {
  ControlConfigAuditWriter,
  ControlConfigServiceOptions,
  ControlConfigSqlClient,
  ReadTaxiConfigInput,
  TaxiControlConfig,
  TaxiControlConfigValues,
  UpdateTaxiConfigInput,
  UpdateTaxiConfigResult,
} from "./types.js";
import {
  isPolicyComplete,
  normalizeReadTaxiConfigInput,
  normalizeUpdateTaxiConfigInput,
} from "./validation.js";

/** Stabiler Audit-Aktionsname dieses Pakets. */
export const CONTROL_CONFIG_AUDIT_ACTION = "control_config.taxi.update";

function readRevision(value: string | undefined): number {
  const revision = value === undefined ? Number.NaN : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new ControlConfigError("Ungueltige gespeicherte Revision.");
  }
  return revision;
}

function readGpsMode(value: string): "aus" {
  if (value !== "aus") {
    throw new ControlConfigError("Ungueltiger gespeicherter GPS-Modus.");
  }
  return "aus";
}

function readSeconds(
  value: string | null,
  field: string,
  minimum: number,
): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new ControlConfigError(
      "Ungueltiger gespeicherter Wert fuer " + field + ".",
    );
  }
  return parsed;
}

function readBooleanOrNull(value: boolean | null, field: string): boolean | null {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  throw new ControlConfigError(
    "Ungueltiger gespeicherter Wert fuer " + field + ".",
  );
}

function toConfigValues(row: ControlConfigRow): TaxiControlConfigValues {
  return {
    gps_mode: readGpsMode(row.gps_mode),
    pause_max_duration_s: readSeconds(
      row.pause_max_duration_s,
      "pause_max_duration_s",
      1,
    ),
    pause_end_on_vehicle_off: readBooleanOrNull(
      row.pause_end_on_vehicle_off,
      "pause_end_on_vehicle_off",
    ),
    display_run_on_s: readSeconds(
      row.display_run_on_s,
      "display_run_on_s",
      0,
    ),
  };
}

function presentConfig(
  taxiId: string,
  revision: number,
  values: TaxiControlConfigValues,
): TaxiControlConfig {
  return {
    taxi_id: taxiId,
    revision,
    ...values,
    policy_complete: isPolicyComplete(values),
  };
}

/**
 * Kanonischer Inhalt einer Aenderung. expected_revision ist bewusst nicht
 * enthalten: eine Wiederholung derselben change_id mit gleichem Inhalt bleibt
 * auch dann idempotent, wenn der Aufrufer inzwischen eine andere Revision
 * erwartet.
 */
function contentFingerprint(
  taxiId: string,
  config: TaxiControlConfigValues,
): string {
  const canonical = JSON.stringify({
    taxi_id: taxiId,
    gps_mode: config.gps_mode,
    pause_max_duration_s: config.pause_max_duration_s,
    pause_end_on_vehicle_off: config.pause_end_on_vehicle_off,
    display_run_on_s: config.display_run_on_s,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Persistenter Konfigurationsservice fuer taxiweise Pausenparameter.
 *
 * - GPS ist hart auf "aus" gesperrt; es gibt kein Request-Feld und keinen
 *   Konfigurationswert, der eine Rechtsfreigabe ersetzt.
 * - Schreibwege sind transaktional und serialisieren je Taxi ueber die
 *   Zustandszeile (select ... for update).
 * - Idempotenz ueber change_id wird vor expected_revision geprueft.
 * - Audit enthaelt Akteur, Taxi, change_id und alte/neue Konfigurationswerte,
 *   aber keine Standort- oder Personendaten.
 */
export class ControlConfigService {
  private readonly pool: ControlConfigServiceOptions["pool"];
  private readonly now: () => Date;
  private readonly auditWriter: ControlConfigAuditWriter | undefined;

  constructor(options: ControlConfigServiceOptions) {
    this.pool = options.pool;
    this.now = options.now ?? (() => new Date());
    this.auditWriter = options.auditWriter;
  }

  private async writeAudit(
    client: ControlConfigSqlClient,
    event: AuditEventInput,
  ): Promise<void> {
    if (this.auditWriter !== undefined) {
      await this.auditWriter(client, event);
      return;
    }
    await insertAuditEvent(client, event);
  }

  async readTaxiConfig(input: ReadTaxiConfigInput): Promise<TaxiControlConfig> {
    const normalized = normalizeReadTaxiConfigInput(input);
    const client = await this.pool.connect();
    try {
      const result = await client.query<ControlConfigRow>(SELECT_CONFIG_SQL, [
        normalized.taxi_id,
      ]);
      if (result.rows.length === 0) {
        return presentConfig(normalized.taxi_id, 0, {
          gps_mode: "aus",
          pause_max_duration_s: null,
          pause_end_on_vehicle_off: null,
          display_run_on_s: null,
        });
      }
      return presentConfig(
        normalized.taxi_id,
        readRevision(result.rows[0].revision),
        toConfigValues(result.rows[0]),
      );
    } finally {
      client.release();
    }
  }

  async updateTaxiConfig(
    input: UpdateTaxiConfigInput,
  ): Promise<UpdateTaxiConfigResult> {
    const normalized = normalizeUpdateTaxiConfigInput(input);
    const appliedAt = this.now();
    if (!(appliedAt instanceof Date) || Number.isNaN(appliedAt.getTime())) {
      throw new ControlConfigError(
        "Die injizierte Serveruhr liefert keinen gueltigen Zeitpunkt.",
      );
    }
    const fingerprint = contentFingerprint(normalized.taxi_id, normalized.config);

    const client = await this.pool.connect();
    let inTransaction = false;
    try {
      await client.query("begin");
      inTransaction = true;

      // Erste Aenderung legt die Zustandszeile an; danach serialisiert die
      // Zeilensperre alle konkurrierenden Aenderungen desselben Taxis.
      await client.query(INSERT_DEFAULT_CONFIG_SQL, [
        normalized.taxi_id,
        appliedAt,
      ]);
      const locked = await client.query<ControlConfigRow>(LOCK_CONFIG_SQL, [
        normalized.taxi_id,
      ]);
      const currentRow = locked.rows[0];
      if (currentRow === undefined) {
        throw new ControlConfigError(
          "Konfigurationszeile konnte nicht gesperrt werden.",
        );
      }
      const currentRevision = readRevision(currentRow.revision);

      // Idempotenz strikt vor der Revisionspruefung.
      const existing = await client.query<ControlConfigChangeRow>(
        SELECT_CHANGE_SQL,
        [normalized.change_id],
      );
      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (
          row.taxi_id !== normalized.taxi_id ||
          row.content_fingerprint !== fingerprint
        ) {
          throw new ControlConfigChangeConflictError(normalized.change_id);
        }
        const values = toConfigValues(row);
        await client.query("commit");
        inTransaction = false;
        return {
          ...presentConfig(
            row.taxi_id,
            readRevision(row.revision),
            values,
          ),
          change_id: row.change_id,
          idempotent: true,
        };
      }

      if (normalized.expected_revision !== currentRevision) {
        throw new ControlConfigRevisionConflictError(
          normalized.expected_revision,
          currentRevision,
        );
      }

      const previousValues = toConfigValues(currentRow);
      const revision = currentRevision + 1;

      await client.query(INSERT_CHANGE_SQL, [
        normalized.change_id,
        normalized.taxi_id,
        revision,
        fingerprint,
        normalized.actor.id,
        normalized.config.gps_mode,
        normalized.config.pause_max_duration_s,
        normalized.config.pause_end_on_vehicle_off,
        normalized.config.display_run_on_s,
        appliedAt,
      ]);
      await client.query(UPDATE_CONFIG_SQL, [
        normalized.taxi_id,
        revision,
        normalized.config.gps_mode,
        normalized.config.pause_max_duration_s,
        normalized.config.pause_end_on_vehicle_off,
        normalized.config.display_run_on_s,
        appliedAt,
      ]);

      await this.writeAudit(client, {
        at: appliedAt,
        actorType: "admin",
        actorId: normalized.actor.id,
        action: CONTROL_CONFIG_AUDIT_ACTION,
        targetType: "taxi",
        targetId: normalized.taxi_id,
        details: {
          change_id: normalized.change_id,
          revision,
          expected_revision: normalized.expected_revision,
          previous: {
            gps_mode: previousValues.gps_mode,
            pause_max_duration_s: previousValues.pause_max_duration_s,
            pause_end_on_vehicle_off:
              previousValues.pause_end_on_vehicle_off,
            display_run_on_s: previousValues.display_run_on_s,
          },
          next: {
            gps_mode: normalized.config.gps_mode,
            pause_max_duration_s: normalized.config.pause_max_duration_s,
            pause_end_on_vehicle_off:
              normalized.config.pause_end_on_vehicle_off,
            display_run_on_s: normalized.config.display_run_on_s,
          },
        },
      });

      await client.query("commit");
      inTransaction = false;
      return {
        ...presentConfig(normalized.taxi_id, revision, normalized.config),
        change_id: normalized.change_id,
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
}

export function createControlConfigService(
  options: ControlConfigServiceOptions,
): ControlConfigService {
  return new ControlConfigService(options);
}
