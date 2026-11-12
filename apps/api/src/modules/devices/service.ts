import type { Pool } from "pg";
import type { AppConfig } from "../../config.js";
import {
  listDeviceRows,
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

/**
 * Geraeteliste fuer das Dashboard (API-VERTRAG.md Abschnitt 5). Der
 * Verbindungsstatus wird zur Lesezeit aus der injizierbaren Serveruhr
 * berechnet (T6 in ARCHITEKTUR.md Abschnitt 9).
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
}
