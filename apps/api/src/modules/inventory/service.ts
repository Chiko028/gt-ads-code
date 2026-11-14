/**
 * CX-128 / R-106 (Teil 1): revisionsgesicherter Inventarschreibkern fuer
 * bestehende Tablets. Ersetzt nur die drei optionalen Inventarfelder;
 * Geraeteidentitaet und Aktivzustand bleiben unberuehrt.
 */
import type { Pool } from "pg";
import { AuditService } from "../audit/service.js";

/** Grenzwerte nach aeusserem Trimmen, in Unicode-Codepunkten. */
export const INVENTORY_SERIAL_NUMBER_MAX = 128;
export const INVENTORY_DEVICE_TYPE_MAX = 64;
export const INVENTORY_REPLACEMENT_NOTE_MAX = 1000;

/** Einziges Audit-Ereignis; Details enthalten nur Feldnamen, keine Werte. */
export const INVENTORY_AUDIT_ACTION = "device.inventory.updated";
export const INVENTORY_AUDIT_TARGET_TYPE = "device";
export const INVENTORY_AUDIT_FIELDS = Object.freeze([
  "serial_number", "device_type", "replacement_note",
] as const);
export type InventoryFieldName = (typeof INVENTORY_AUDIT_FIELDS)[number];

export interface DeviceInventory {
  deviceId: string;
  serialNumber: string | null;
  deviceType: string | null;
  replacementNote: string | null;
  revision: number;
}

export interface DeviceInventoryFields {
  serialNumber: string | null;
  deviceType: string | null;
  replacementNote: string | null;
}

export interface ReplaceDeviceInventoryInput extends DeviceInventoryFields {
  /** 0, solange kein Inventarsatz existiert; sonst die gelesene Revision. */
  expectedRevision: number;
}

export type InventoryErrorCode =
  | "invalid_request"
  | "not_found"
  | "revision_conflict";

export class InventoryError extends Error {
  readonly code: InventoryErrorCode;

  constructor(code: InventoryErrorCode, message: string) {
    super(message);
    this.name = "InventoryError";
    this.code = code;
  }
}

interface InventoryRow {
  device_id: string;
  serial_number: string | null;
  device_type: string | null;
  replacement_note: string | null;
  revision: number;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVENTORY_COLUMNS = [
  "device_id::text as device_id", "serial_number", "device_type",
  "replacement_note", "revision",
].join(", ");
const FIELD_INPUT_NAMES = [
  "serialNumber", "deviceType", "replacementNote",
] as const;

function invalid(message: string): never {
  throw new InventoryError("invalid_request", message);
}

function normalizeDeviceId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    invalid("Die Geraete-ID muss eine UUID sein.");
  }
  return value.toLowerCase();
}

function normalizeExpectedRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    invalid("Die erwartete Revision muss eine ganze Zahl ab 0 sein.");
  }
  return value;
}

function normalizeActorId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" ||
      Array.from(value).length > 128) {
    invalid("Ein Akteur mit 1 bis 128 Zeichen ist erforderlich.");
  }
  return value;
}

function normalizeNullableText(
  value: unknown,
  maxLength: number,
  label: string,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    invalid(label + " muss ein Text oder null sein.");
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (Array.from(trimmed).length > maxLength) {
    invalid(label + " ueberschreitet " + maxLength + " Zeichen.");
  }
  return trimmed;
}

function normalizeFields(input: unknown): DeviceInventoryFields {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    invalid("Die Inventarfelder fehlen.");
  }
  const record = input as Record<string, unknown>;
  for (const name of FIELD_INPUT_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(record, name)) {
      invalid("Das Inventarfeld " + name + " fehlt.");
    }
  }
  return {
    serialNumber: normalizeNullableText(
      record.serialNumber, INVENTORY_SERIAL_NUMBER_MAX, "Die Seriennummer",
    ),
    deviceType: normalizeNullableText(
      record.deviceType, INVENTORY_DEVICE_TYPE_MAX, "Der Geraetetyp",
    ),
    replacementNote: normalizeNullableText(
      record.replacementNote, INVENTORY_REPLACEMENT_NOTE_MAX,
      "Der Austauschvermerk",
    ),
  };
}

function toInventory(row: InventoryRow): DeviceInventory {
  return {
    deviceId: row.device_id,
    serialNumber: row.serial_number,
    deviceType: row.device_type,
    replacementNote: row.replacement_note,
    revision: row.revision,
  };
}

/** Nur Namen tatsaechlich geaenderter Felder, niemals deren Werte. */
function changedFields(
  previous: InventoryRow | null,
  current: InventoryRow,
): InventoryFieldName[] {
  return INVENTORY_AUDIT_FIELDS.filter(
    (field) => (previous === null ? null : previous[field]) !== current[field],
  );
}

function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: unknown }).code === "23503";
}

export interface DeviceInventoryServiceOptions {
  pool: Pool;
  now?: () => Date;
}

/**
 * Einzige Mutationsstelle der optionalen 1:1-Inventartabelle. Lesen, Sperren,
 * Schreiben und Audit laufen auf demselben Transaktionsclient. Der fehlende
 * Satz entspricht Revision 0; erstmaliges Speichern setzt Revision 1.
 */
export class DeviceInventoryService {
  private readonly pool: Pool;
  private readonly now: () => Date;
  private readonly audit: AuditService;

  constructor(options: DeviceInventoryServiceOptions) {
    this.pool = options.pool;
    this.now = options.now ?? (() => new Date());
    this.audit = new AuditService({ executor: this.pool });
  }

  async replaceInventory(
    deviceId: unknown,
    input: ReplaceDeviceInventoryInput,
    actorId: unknown,
  ): Promise<DeviceInventory> {
    const id = normalizeDeviceId(deviceId);
    const fields = normalizeFields(input);
    const expectedRevision = normalizeExpectedRevision(input.expectedRevision);
    const actor = normalizeActorId(actorId);
    const at = this.now();
    const client = await this.pool.connect();

    try {
      await client.query("begin");
      const device = await client.query(
        "select id from devices where id = $1::uuid", [id],
      );
      if ((device.rowCount ?? 0) === 0) {
        throw new InventoryError("not_found", "Das Geraet existiert nicht.");
      }

      let previous: InventoryRow | null = null;
      let row: InventoryRow | undefined;

      if (expectedRevision === 0) {
        const inserted = await client.query<InventoryRow>(
          "insert into device_inventory (device_id, serial_number, device_type, replacement_note, revision) values ($1::uuid, $2, $3, $4, 1) on conflict (device_id) do nothing returning " +
            INVENTORY_COLUMNS,
          [id, fields.serialNumber, fields.deviceType, fields.replacementNote],
        );
        row = inserted.rows[0];
        if (row === undefined) {
          throw new InventoryError(
            "revision_conflict",
            "Das Inventar wurde zwischenzeitlich angelegt.",
          );
        }
      } else {
        const locked = await client.query<InventoryRow>(
          "select " + INVENTORY_COLUMNS +
            " from device_inventory where device_id = $1::uuid for update",
          [id],
        );
        previous = locked.rows[0] ?? null;
        if (previous === null || previous.revision !== expectedRevision) {
          throw new InventoryError(
            "revision_conflict",
            "Die erwartete Revision ist nicht mehr aktuell.",
          );
        }
        const updated = await client.query<InventoryRow>(
          "update device_inventory set serial_number = $2, device_type = $3, replacement_note = $4, revision = revision + 1 where device_id = $1::uuid and revision = $5 returning " +
            INVENTORY_COLUMNS,
          [
            id, fields.serialNumber, fields.deviceType,
            fields.replacementNote, expectedRevision,
          ],
        );
        row = updated.rows[0];
        if (row === undefined) {
          throw new InventoryError(
            "revision_conflict",
            "Die erwartete Revision ist nicht mehr aktuell.",
          );
        }
      }

      await this.audit.recordWith(
        client,
        {
          actorType: "admin",
          actorId: actor,
          action: INVENTORY_AUDIT_ACTION,
          targetType: INVENTORY_AUDIT_TARGET_TYPE,
          targetId: row.device_id,
          details: {
            revision: row.revision,
            changed_fields: changedFields(previous, row),
          },
        },
        at,
      );

      await client.query("commit");
      return toInventory(row);
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // Der urspruengliche Fehler bleibt massgeblich.
      }
      if (isForeignKeyViolation(error)) {
        throw new InventoryError("not_found", "Das Geraet existiert nicht.");
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
