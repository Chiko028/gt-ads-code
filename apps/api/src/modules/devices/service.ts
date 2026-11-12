import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../../config.js";
import { ApiError } from "../../http/errors.js";
import { AUDIT_ACTIONS, insertAuditEvent } from "../audit/repository.js";
import {
  findDeviceDetailRow,
  listDeviceRows,
  lockDeviceRow,
  revokeDeviceRow,
  type DeviceDetailRow,
  type DeviceListRow,
} from "./repository.js";
import {
  deriveConnectivity,
  type DeviceConnectivity,
} from "./status.js";

export interface DeviceListItem {
  id: string;
  label: string | null;
  manufacturer: string;
  model: string;
  osVersion: string;
  sdkInt: number;
  appVersion: string;
  appFlavor: string;
  state: "active" | "revoked";
  registeredAt: Date;
  lastSeenAt: Date;
  /** Zur Lesezeit berechnet (AC-10); nie gespeichert. */
  connectivity: DeviceConnectivity;
}

/** Detailansicht: Listenfelder plus Clock-Offset und Registrierungscode. */
export interface DeviceDetailItem extends DeviceListItem {
  lastClockOffsetMs: number | null;
  registrationCodeId: string;
}

export interface DeviceListResult {
  serverTime: Date;
  onlineThresholdSeconds: number;
  items: DeviceListItem[];
  /** Wahr, wenn mehr als die Obergrenze an Geraeten vorhanden ist. */
  truncated: boolean;
}

export interface DevicesServiceOptions {
  pool: Pool;
  config: AppConfig;
  now?: () => Date;
}

/** Actor-ID des Pilot-Admins in Audit-Eintraegen (E51). */
export const DEVICE_ADMIN_ACTOR_ID = "admin";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toItem(
  row: DeviceListRow,
  serverTime: Date,
  onlineThresholdSeconds: number,
): DeviceListItem {
  return {
    id: row.id,
    label: row.label,
    manufacturer: row.manufacturer,
    model: row.model,
    osVersion: row.os_version,
    sdkInt: row.sdk_int,
    appVersion: row.app_version,
    appFlavor: row.app_flavor,
    state: row.state,
    registeredAt: new Date(row.registered_at),
    lastSeenAt: new Date(row.last_seen_at),
    connectivity: deriveConnectivity({
      lastSeenAt: new Date(row.last_seen_at),
      serverTime,
      onlineThresholdSeconds,
    }),
  };
}

function readClockOffsetMs(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function toDetailItem(
  row: DeviceDetailRow,
  serverTime: Date,
  onlineThresholdSeconds: number,
): DeviceDetailItem {
  return {
    ...toItem(row, serverTime, onlineThresholdSeconds),
    lastClockOffsetMs: readClockOffsetMs(row.last_clock_offset_ms),
    registrationCodeId: row.registration_code_id,
  };
}

/**
 * Geraeteliste und Geraeteverwaltung fuer das Dashboard
 * (API-VERTRAG.md Abschnitt 5). Der Verbindungsstatus wird zur Lesezeit aus
 * der injizierbaren Serveruhr berechnet (T6 in ARCHITEKTUR.md Abschnitt 9).
 */
export class DevicesService {
  private readonly pool: Pool;
  private readonly config: AppConfig;
  private readonly now: () => Date;

  constructor(options: DevicesServiceOptions) {
    this.pool = options.pool;
    this.config = options.config;
    this.now = options.now ?? (() => new Date());
  }

  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // Der urspruengliche Fehler bleibt relevant.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listDevices(): Promise<DeviceListResult> {
    const serverTime = this.now();
    const { rows, truncated } = await listDeviceRows(this.pool);
    return {
      serverTime,
      onlineThresholdSeconds: this.config.onlineThresholdSeconds,
      items: rows.map((row) =>
        toItem(row, serverTime, this.config.onlineThresholdSeconds),
      ),
      truncated,
    };
  }

  /** Detailansicht; unbekannte oder formal ungueltige ID ergibt 404. */
  async getDevice(id: string): Promise<DeviceDetailItem> {
    const deviceId = normalizeDeviceId(id);
    const row = await findDeviceDetailRow(this.pool, deviceId);
    if (row === null) {
      throw ApiError.notFound();
    }
    return toDetailItem(row, this.now(), this.config.onlineThresholdSeconds);
  }

  /**
   * Sperrt ein Geraet (AC-08). Bereits gesperrte Geraete bleiben ohne Fehler;
   * die Sperre wirkt bei der naechsten Token-Pruefung sofort.
   */
  async revokeDevice(id: string, revokedBy = DEVICE_ADMIN_ACTOR_ID): Promise<void> {
    const deviceId = normalizeDeviceId(id);
    const revokedAt = this.now();

    await this.transaction(async (client) => {
      const row = await lockDeviceRow(client, deviceId);
      if (row === null) {
        throw ApiError.notFound();
      }
      if (row.state === "revoked") {
        return;
      }
      const revoked = await revokeDeviceRow(client, deviceId, revokedAt, revokedBy);
      if (!revoked) {
        // Zwischen Lesen und Schreiben gesperrt: kein Fehler, Sperre steht.
        return;
      }
      await insertAuditEvent(client, {
        at: revokedAt,
        actorType: "admin",
        actorId: revokedBy,
        action: AUDIT_ACTIONS.deviceRevoked,
        targetType: "device",
        targetId: deviceId,
        details: {},
      });
    });
  }
}

function normalizeDeviceId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw ApiError.notFound();
  }
  return normalized;
}
