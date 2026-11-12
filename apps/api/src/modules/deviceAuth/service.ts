import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../../config.js";
import { verifyDeviceSignature } from "../../crypto/deviceSignature.js";
import {
  generateAccessToken,
  generateNonce,
  hashNonce,
  hashToken,
  isValidOpaqueToken,
} from "../../crypto/tokens.js";
import { ApiError } from "../../http/errors.js";
import {
  consumeChallenge,
  findDeviceById,
  findDeviceByIdForUpdate,
  findTokenWithDevice,
  insertAccessToken,
  insertChallenge,
  updateLastSeenAt,
} from "./repository.js";

export interface ChallengeResult {
  nonce: string;
  expiresAt: Date;
}

export interface TokenResult {
  accessToken: string;
  tokenType: "Bearer";
  expiresAt: Date;
}

export interface DeviceAuthContext {
  deviceId: string;
  tokenId: string;
}

export interface IssueTokenInput {
  deviceId: string;
  nonce: string;
  signature: string;
}

export interface DeviceAuthServiceOptions {
  pool: Pool;
  config: AppConfig;
  now?: () => Date;
}

/**
 * Ein Fehlercode fuer unbekannte, abgelaufene und bereits benutzte Nonces
 * sowie falsche Signaturen; nach aussen nicht unterscheidbar (API-VERTRAG 3).
 */
function challengeInvalid(): ApiError {
  return new ApiError("challenge_invalid");
}

/**
 * Challenge-Response-Authentifizierung (API-VERTRAG.md Abschnitt 3,
 * ARCHITEKTUR.md Abschnitt 4). Nonces und Tokens werden nur als Hash
 * gespeichert; der Geraetezustand wird bei jeder Token-Pruefung geladen.
 */
export class DeviceAuthService {
  private readonly pool: Pool;
  private readonly config: AppConfig;
  private readonly now: () => Date;

  constructor(options: DeviceAuthServiceOptions) {
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

  /**
   * Stellt eine einmalige, kurzlebige Nonce aus. Unbekannte Geraete erhalten
   * 401 unauthorized; ein gesperrtes Geraet darf die Sperre erfahren (403).
   */
  async createChallenge(deviceId: string): Promise<ChallengeResult> {
    const now = this.now();
    const device = await findDeviceById(this.pool, deviceId);
    if (device === null) {
      throw ApiError.unauthorized();
    }
    if (device.state === "revoked") {
      throw ApiError.deviceRevoked();
    }

    const nonce = generateNonce();
    const expiresAt = new Date(
      now.getTime() + this.config.challengeTtlSeconds * 1000,
    );
    await insertChallenge(this.pool, {
      id: randomUUID(),
      deviceId: device.id,
      nonceHash: hashNonce(nonce),
      createdAt: now,
      expiresAt,
    });
    return { nonce, expiresAt };
  }

  /**
   * Prueft Nonce und Signatur und stellt ein kurzlebiges Access-Token aus.
   * Die Nonce wird atomar verbraucht; danach werden last_seen_at und das
   * Token in derselben Transaktion geschrieben.
   */
  async issueToken(input: IssueTokenInput): Promise<TokenResult> {
    const now = this.now();
    if (!isValidOpaqueToken(input.nonce)) {
      throw challengeInvalid();
    }

    return this.transaction(async (client) => {
      const device = await findDeviceByIdForUpdate(client, input.deviceId);
      if (device === null) {
        throw challengeInvalid();
      }
      if (device.state === "revoked") {
        throw ApiError.deviceRevoked();
      }

      const signatureValid = verifyDeviceSignature({
        publicKeySpki: device.public_key_spki.toString("base64"),
        deviceId: device.id,
        nonce: input.nonce,
        signature: input.signature,
      });
      if (!signatureValid) {
        throw challengeInvalid();
      }

      const consumed = await consumeChallenge(client, {
        deviceId: device.id,
        nonceHash: hashNonce(input.nonce),
        usedAt: now,
      });
      if (consumed === null) {
        // Unbekannt, abgelaufen oder bereits benutzt: gleicher Fehler.
        throw challengeInvalid();
      }

      await updateLastSeenAt(client, device.id, now);

      const accessToken = generateAccessToken();
      const expiresAt = new Date(
        now.getTime() + this.config.accessTokenTtlSeconds * 1000,
      );
      await insertAccessToken(client, {
        id: randomUUID(),
        deviceId: device.id,
        tokenHash: hashToken(accessToken),
        createdAt: now,
        expiresAt,
      });

      return { accessToken, tokenType: "Bearer", expiresAt };
    });
  }

  /**
   * Prueft ein Bearer-Token bei jeder Anfrage. Ein gesperrtes Geraet macht
   * bestehende Tokens sofort ungueltig (AC-08); abgelaufene oder unbekannte
   * Tokens ergeben 401 unauthorized.
   */
  async authenticateToken(token: string): Promise<DeviceAuthContext> {
    if (!isValidOpaqueToken(token)) {
      throw ApiError.unauthorized();
    }
    const now = this.now();
    const row = await findTokenWithDevice(this.pool, hashToken(token));
    if (row === null) {
      throw ApiError.unauthorized();
    }
    if (row.device_state === "revoked") {
      throw ApiError.deviceRevoked();
    }
    if (row.token_revoked_at !== null) {
      throw ApiError.unauthorized();
    }
    if (new Date(row.token_expires_at).getTime() <= now.getTime()) {
      throw ApiError.unauthorized();
    }
    return { deviceId: row.device_id, tokenId: row.token_id };
  }
}
