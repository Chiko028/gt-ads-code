import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../../config.js";
import {
  parsePublicKeySpki,
  publicKeyFingerprint,
} from "../../crypto/deviceSignature.js";
import {
  generateRegistrationCode,
  hashRegistrationCode,
} from "../../crypto/registrationCode.js";
import { ApiError } from "../../http/errors.js";
import { AUDIT_ACTIONS, insertAuditEvent } from "../audit/repository.js";
import type { ParsedRegistrationRequest } from "./validation.js";
import { isUuidV4 } from "./validation.js";
import {
  findCodeByHashForUpdate,
  findDeviceByFingerprint,
  findDeviceByRegistrationCodeId,
  insertDevice,
  insertRegistrationCode,
  listRegistrationCodes,
  markCodeUsed,
  revokeUnusedCode,
  type RegistrationCodeRow,
} from "./repository.js";

export type RegistrationCodeStatus = "pending" | "used" | "expired" | "revoked";

export interface CreatedRegistrationCode {
  id: string;
  code: string;
  label: string | null;
  expiresAt: Date;
}

export interface RegistrationCodeListItem {
  id: string;
  label: string | null;
  createdAt: Date;
  expiresAt: Date;
  status: RegistrationCodeStatus;
}

export interface RegistrationResult {
  deviceId: string;
  serverTime: Date;
  serverEnv: AppConfig["env"];
  heartbeatIntervalSeconds: number;
}

export interface RegistrationServiceOptions {
  pool: Pool;
  config: AppConfig;
  now?: () => Date;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505"
  );
}

function normalizeLabel(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw ApiError.invalidRequest();
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > 64) {
    throw ApiError.invalidRequest();
  }
  return trimmed;
}

function statusOf(row: RegistrationCodeRow, now: Date): RegistrationCodeStatus {
  if (row.used_at !== null) {
    return "used";
  }
  if (row.revoked_at !== null) {
    return "revoked";
  }
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    return "expired";
  }
  return "pending";
}

/**
 * Registrierung nach API-VERTRAG.md Abschnitt 2 und ARCHITEKTUR.md
 * Abschnitte 3/4. Alle Zeitentscheidungen nutzen die injizierbare Serveruhr.
 */
export class RegistrationService {
  private readonly pool: Pool;
  private readonly config: AppConfig;
  private readonly now: () => Date;

  constructor(options: RegistrationServiceOptions) {
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

  /** Admin-Funktion; der Klartext-Code wird nur hier zurueckgegeben (AC-05). */
  async createRegistrationCode(
    input: { label?: unknown; createdBy?: string } = {},
  ): Promise<CreatedRegistrationCode> {
    const label = normalizeLabel(input.label);
    const createdBy = input.createdBy ?? "admin";
    const createdAt = this.now();
    const id = randomUUID();
    const expiresAt = new Date(
      createdAt.getTime() + this.config.registrationCodeTtlSeconds * 1000,
    );
    const code = generateRegistrationCode(this.config.registrationCodeLength);
    const codeHash = hashRegistrationCode(
      code,
      this.config.registrationCodePepper,
    );

    await this.transaction(async (client) => {
      await insertRegistrationCode(client, {
        id,
        codeHash,
        label,
        createdAt,
        createdBy,
        expiresAt,
      });
      await insertAuditEvent(client, {
        at: createdAt,
        actorType: "admin",
        actorId: createdBy,
        action: AUDIT_ACTIONS.registrationCodeCreated,
        targetType: "registration_code",
        targetId: id,
        details: { label },
      });
    });

    return { id, code, label, expiresAt };
  }

  /** Widerruft einen unbenutzten Code; benutzt/unbekannt ergibt not_found. */
  async revokeRegistrationCode(id: string, revokedBy = "admin"): Promise<void> {
    if (!isUuidV4(id)) {
      throw ApiError.notFound();
    }
    const revokedAt = this.now();
    await this.transaction(async (client) => {
      const revoked = await revokeUnusedCode(
        client,
        id.toLowerCase(),
        revokedAt,
        revokedBy,
      );
      if (revoked === null) {
        throw ApiError.notFound();
      }
      await insertAuditEvent(client, {
        at: revokedAt,
        actorType: "admin",
        actorId: revokedBy,
        action: AUDIT_ACTIONS.registrationCodeRevoked,
        targetType: "registration_code",
        targetId: revoked.id,
        details: {},
      });
    });
  }

  async listRegistrationCodes(): Promise<RegistrationCodeListItem[]> {
    const now = this.now();
    const rows = await listRegistrationCodes(this.pool);
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status: statusOf(row, now),
    }));
  }

  /**
   * Loest einen Code atomar ein und legt das Geraet an. Fehler nach aussen
   * sind gleichfoermig (AC-03); die Idempotenzpruefung erfolgt vor der
   * Gueltigkeitspruefung, damit eine Wiederholung nach Verbrauch 201 liefert.
   */
  async register(input: ParsedRegistrationRequest): Promise<RegistrationResult> {
    if (input.appEnv !== this.config.env) {
      // Vor jeder Codepruefung: der Code bleibt unverbraucht (AC-15).
      throw ApiError.environmentMismatch();
    }

    const now = this.now();
    const key = parsePublicKeySpki(input.publicKeySpki);
    const spkiDer = key.export({ format: "der", type: "spki" }) as Buffer;
    const fingerprint = publicKeyFingerprint(input.publicKeySpki);
    const codeHash = hashRegistrationCode(
      input.registrationCode,
      this.config.registrationCodePepper,
    );

    try {
      return await this.transaction(async (client) => {
        const codeRow = await findCodeByHashForUpdate(client, codeHash);
        if (codeRow === null) {
          throw ApiError.invalidRegistrationCode();
        }

        const existing = await findDeviceByRegistrationCodeId(client, codeRow.id);
        if (existing !== null) {
          if (
            existing.registration_request_id === input.clientRequestId &&
            existing.public_key_fingerprint === fingerprint
          ) {
            return {
              deviceId: existing.id,
              serverTime: now,
              serverEnv: this.config.env,
              heartbeatIntervalSeconds: this.config.heartbeatIntervalSeconds,
            };
          }
          throw ApiError.invalidRegistrationCode();
        }

        if (
          codeRow.used_at !== null ||
          codeRow.revoked_at !== null ||
          new Date(codeRow.expires_at).getTime() <= now.getTime()
        ) {
          throw ApiError.invalidRegistrationCode();
        }

        const duplicate = await findDeviceByFingerprint(client, fingerprint);
        if (duplicate !== null) {
          throw ApiError.keyAlreadyRegistered();
        }

        const deviceId = randomUUID();
        await insertDevice(client, {
          id: deviceId,
          label: codeRow.label,
          publicKeySpki: spkiDer,
          publicKeyFingerprint: fingerprint,
          manufacturer: input.deviceInfo.manufacturer,
          model: input.deviceInfo.model,
          osVersion: input.deviceInfo.osVersion,
          sdkInt: input.deviceInfo.sdkInt,
          appVersion: input.deviceInfo.appVersion,
          appFlavor: input.deviceInfo.appFlavor,
          registrationCodeId: codeRow.id,
          registrationRequestId: input.clientRequestId,
          registeredAt: now,
          lastSeenAt: now,
        });

        const marked = await markCodeUsed(client, codeRow.id, now, deviceId);
        if (!marked) {
          throw ApiError.invalidRegistrationCode();
        }

        await insertAuditEvent(client, {
          at: now,
          actorType: "device",
          actorId: deviceId,
          action: AUDIT_ACTIONS.registrationCodeUsed,
          targetType: "registration_code",
          targetId: codeRow.id,
          details: { device_id: deviceId },
        });

        await insertAuditEvent(client, {
          at: now,
          actorType: "device",
          actorId: deviceId,
          action: AUDIT_ACTIONS.deviceRegistered,
          targetType: "device",
          targetId: deviceId,
          details: {
            label: codeRow.label,
            manufacturer: input.deviceInfo.manufacturer,
            model: input.deviceInfo.model,
            os_version: input.deviceInfo.osVersion,
            sdk_int: input.deviceInfo.sdkInt,
            app_version: input.deviceInfo.appVersion,
            app_flavor: input.deviceInfo.appFlavor,
          },
        });

        return {
          deviceId,
          serverTime: now,
          serverEnv: this.config.env,
          heartbeatIntervalSeconds: this.config.heartbeatIntervalSeconds,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw ApiError.keyAlreadyRegistered();
      }
      throw error;
    }
  }
}
