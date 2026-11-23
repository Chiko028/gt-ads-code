import type { Pool } from "pg";
import type { AppConfig } from "../../config.js";
import { ApiError } from "../../http/errors.js";
import { findDeviceState, recordHeartbeat } from "./repository.js";

export interface HeartbeatInput {
  /** Pro App-Installation monoton; ganzzahlig >= 0. */
  seq: number;
  /** nur fuer den Clock-Offset, nie als Wahrheit (AC-09). */
  deviceTime: Date;
  appVersion: string;
  osVersion: string;
}

export interface HeartbeatResult {
  serverTime: Date;
  deviceState: "active";
  heartbeatIntervalSeconds: number;
}

export interface HeartbeatServiceOptions {
  pool: Pool;
  config: AppConfig;
  now?: () => Date;
}

/**
 * Heartbeat nach API-VERTRAG.md Abschnitt 4 und ARCHITEKTUR.md Abschnitt 4.
 * `last_seen_at` ist immer die Serverzeit; die Geraetezeit wird nur als
 * `clock_offset` (Server - Geraet) protokolliert (AC-09).
 */
export class HeartbeatService {
  private readonly pool: Pool;
  private readonly config: AppConfig;
  private readonly now: () => Date;

  constructor(options: HeartbeatServiceOptions) {
    this.pool = options.pool;
    this.config = options.config;
    this.now = options.now ?? (() => new Date());
  }

  async record(deviceId: string, input: HeartbeatInput): Promise<HeartbeatResult> {
    const serverTime = this.now();
    const clockOffsetMs =
      BigInt(serverTime.getTime()) - BigInt(input.deviceTime.getTime());

    const updated = await recordHeartbeat(this.pool, {
      deviceId,
      seenAt: serverTime,
      seq: input.seq,
      clockOffsetMs,
      appVersion: input.appVersion,
      osVersion: input.osVersion,
    });

    if (updated === null) {
      // Zwischen Token-Pruefung und Update gesperrt oder entfernt.
      const device = await findDeviceState(this.pool, deviceId);
      if (device !== null && device.state === "revoked") {
        throw ApiError.deviceRevoked();
      }
      throw ApiError.unauthorized();
    }

    return {
      serverTime,
      deviceState: "active",
      heartbeatIntervalSeconds: this.config.heartbeatIntervalSeconds,
    };
  }
}
