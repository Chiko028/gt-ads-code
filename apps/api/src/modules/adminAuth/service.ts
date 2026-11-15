import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AppConfig } from "../../config.js";
import {
  hashPassword,
  verifyPassword,
  type ScryptParams,
} from "../../crypto/password.js";
import {
  generateAdminSessionToken,
  hashToken,
  isValidOpaqueToken,
} from "../../crypto/tokens.js";
import { ApiError } from "../../http/errors.js";
import { AuditService } from "../audit/service.js";
import { AUDIT_ACTIONS, insertAuditEvent } from "../audit/repository.js";
import {
  deleteAdminSessionByTokenHash,
  findAdminSessionByTokenHash,
  findOperatorByUsername,
  findOperatorForUpdate,
  findOperatorStatusById,
  insertAdminSession,
  insertOperator,
  markOperatorDisabled,
} from "./repository.js";

/** Kontext einer gueltigen Admin-Sitzung (nur nach Cookie-Pruefung). */
export interface AdminSessionContext {
  sessionId: string;
  /** Klartext-Token; nur zum Loeschen beim Logout benoetigt. */
  token: string;
  expiresAt: Date;
  /** Stabile Actor-ID der Sitzung (Operator-UUID oder legacy-admin). */
  actorId: string;
  role: AdminSessionRole;
}

export type AdminSessionRole = "Admin" | "Operator";

export interface AdminLoginResult {
  token: string;
  expiresAt: Date;
}

export interface AdminAuthServiceOptions {
  pool: Pool;
  config: AppConfig;
  now?: () => Date;
}

/** Feste Actor-ID fuer Audit-Eintraege des Pilot-Admins (E51). */
export const ADMIN_ACTOR_ID = "admin";

/**
 * Feste Identitaet des bisherigen konfigurierten Administrators. Neue
 * Legacy-Sitzungen speichern keine eigene Actor-Spalte; der Resolver bildet
 * sie auf diese stabile ID ab.
 */
export const LEGACY_ADMIN_ACTOR_ID = "legacy-admin";

/** Versionierte scrypt-Parameter fuer persistente Operatorkonten. */
export const OPERATOR_SCRYPT_PARAMS: Readonly<ScryptParams> = Object.freeze({
  N: 32768,
  r: 8,
  p: 1,
  keylen: 64,
});

/** Zufaelliges Salz mit mindestens 16 Byte. */
const OPERATOR_SALT_BYTES = 16;

/**
 * Gueltiger Dummy-Hash mit denselben Parametern. Unbekannte und gesperrte
 * Kennungen durchlaufen damit dieselbe scrypt-Arbeit wie echte Konten; der
 * Wert ist kein Geheimnis und gehoert zu keinem Konto.
 */
const DUMMY_OPERATOR_PASSWORD_HASH =
  "scrypt$N=32768,r=8,p=1$fujMD_f0tRPutNj7VE2AaA$GYHIJqTIIDCp6zf6PXV_mdUnsJh3w18OEJbIFj7hbR57VCi0ZMnnfQvTSM_32oU4IsfNE66hP0D59JdBb9Y0rQ";

export const OPERATOR_USERNAME_PATTERN = /^[a-z0-9._-]{3,64}$/;
/** Katalogwerte; die Namen bleiben unveraendert. */
export const OPERATOR_AUDIT_ACTIONS = Object.freeze({
  created: AUDIT_ACTIONS.operatorCreated,
  disabled: AUDIT_ACTIONS.operatorDisabled,
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreateOperatorInput {
  username: unknown;
  password: unknown;
  /** Serverseitig aufgeloester Akteur der Admin-Sitzung. */
  actorId: unknown;
  /** Fastify-Request-ID; wird nur als Korrelationswert im Audit abgelegt. */
  requestId?: unknown;
}

export interface CreatedOperator {
  operator_id: string;
  username: string;
  status: "active";
}

export interface DisableOperatorInput {
  operatorId: unknown;
  actorId: unknown;
  /** Fastify-Request-ID; wird nur als Korrelationswert im Audit abgelegt. */
  requestId?: unknown;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

/**
 * Kennungen werden getrimmt und auf ASCII-Kleinbuchstaben normalisiert.
 * Es wird ausschliesslich das normalisierte Format gespeichert und gesucht.
 */
export function normalizeOperatorUsername(value: unknown): string {
  if (typeof value !== "string") {
    throw ApiError.invalidRequest();
  }
  const normalized = value.trim().toLowerCase();
  if (!OPERATOR_USERNAME_PATTERN.test(normalized)) {
    throw ApiError.invalidRequest();
  }
  return normalized;
}

/**
 * Passwoerter werden nicht getrimmt: 12-128 Unicode-Codepunkte und
 * hoechstens 512 UTF-8-Bytes. Der Klartext verlaesst diese Funktion nur
 * Richtung scrypt und niemals Richtung Antwort, Audit oder Log.
 */
export function validateOperatorPassword(value: unknown): string {
  if (typeof value !== "string") {
    throw ApiError.invalidRequest();
  }
  const codePoints = Array.from(value).length;
  if (codePoints < 12 || codePoints > 128) {
    throw ApiError.invalidRequest();
  }
  if (Buffer.byteLength(value, "utf8") > 512) {
    throw ApiError.invalidRequest();
  }
  return value;
}

function normalizeActorId(value: unknown): string {
  if (typeof value !== "string") {
    throw ApiError.unauthorized();
  }
  const actorId = value.trim();
  if (actorId.length === 0 || actorId.length > 128) {
    throw ApiError.unauthorized();
  }
  return actorId;
}

function normalizeRequestId(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw ApiError.invalidRequest();
  }
  return value;
}

function normalizeOperatorId(value: unknown): string {
  if (typeof value !== "string") {
    throw ApiError.notFound();
  }
  const operatorId = value.trim();
  if (!UUID_PATTERN.test(operatorId)) {
    throw ApiError.notFound();
  }
  return operatorId.toLowerCase();
}

function conflict(): ApiError {
  return new ApiError("invalid_request", { statusCode: 409 });
}

/**
 * Admin-Anmeldung und Sitzungsverwaltung (API-VERTRAG.md Abschnitt 5,
 * ARCHITEKTUR.md Abschnitt 4).
 *
 * Ohne Kennung bleibt die konfigurierte CX-015-Identitaet unveraendert.
 * Mit Kennung wird gezielt genau ein Operatorkonto geprueft; es gibt keine
 * Iteration ueber Passwoerter. Unbekannte oder gesperrte Kennungen erhalten
 * eine Dummy-scrypt-Pruefung und denselben generischen Fehler.
 */
export class AdminAuthService {
  private readonly pool: Pool;
  private readonly config: AppConfig;
  private readonly now: () => Date;

  constructor(options: AdminAuthServiceOptions) {
    this.pool = options.pool;
    this.config = options.config;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Prueft das Passwort und legt bei Erfolg eine Sitzung an. Falsches
   * Passwort ergibt denselben generischen 401-Fehler wie eine unbekannte
   * oder gesperrte Kennung; der Fehlversuch wird audit- und rate-limitiert
   * (Aufrufer).
   */
  async login(password: string, username?: string): Promise<AdminLoginResult> {
    const now = this.now();
    let sessionActorId: string | null = null;
    let auditActorId = ADMIN_ACTOR_ID;
    let role: AdminSessionRole = "Admin";

    if (username === undefined) {
      const valid = await verifyPassword(password, this.config.adminPasswordHash);
      if (!valid) {
        await this.recordLoginFailure(now);
        throw ApiError.unauthorized();
      }
    } else {
      const normalized = normalizeOperatorUsername(username);
      const operator = await findOperatorByUsername(this.pool, normalized);
      // Auch gesperrte Kennungen bekommen eine Dummy-Pruefung, damit die
      // Antwortzeit keine Aussage ueber den Kontozustand trifft.
      const storedHash =
        operator !== null && operator.status === "active"
          ? operator.password_hash
          : DUMMY_OPERATOR_PASSWORD_HASH;
      const valid = await verifyPassword(password, storedHash);
      if (operator === null || operator.status !== "active" || !valid) {
        await this.recordLoginFailure(now);
        throw ApiError.unauthorized();
      }
      sessionActorId = operator.actor_id;
      auditActorId = operator.actor_id;
      role = "Operator";
    }

    const token = generateAdminSessionToken();
    const expiresAt = new Date(
      now.getTime() + this.config.adminSessionTtlSeconds * 1000,
    );
    await insertAdminSession(this.pool, {
      id: randomUUID(),
      tokenHash: hashToken(token),
      createdAt: now,
      expiresAt,
      actorId: sessionActorId,
    });
    await insertAuditEvent(this.pool, {
      at: now,
      actorType: "admin",
      actorId: auditActorId,
      action: AUDIT_ACTIONS.adminLoginSucceeded,
      details: role === "Operator" ? { role: "Operator" } : {},
    });

    return { token, expiresAt };
  }

  private async recordLoginFailure(at: Date): Promise<void> {
    await insertAuditEvent(this.pool, {
      at,
      actorType: "admin",
      actorId: ADMIN_ACTOR_ID,
      action: AUDIT_ACTIONS.adminLoginFailed,
      details: {},
    });
  }

  /**
   * Prueft ein Sitzungstoken bei jeder Anfrage. Fuer persistente Operatoren
   * wird der aktuelle Status frisch aus PostgreSQL gelesen; ein gesperrtes
   * Konto liefert null und verliert damit auch eine bestehende Sitzung.
   */
  async verifySession(token: string): Promise<AdminSessionContext | null> {
    if (!isValidOpaqueToken(token)) {
      return null;
    }
    const now = this.now();
    const row = await findAdminSessionByTokenHash(this.pool, hashToken(token));
    if (row === null) {
      return null;
    }
    const expiresAt = new Date(row.expires_at);
    if (expiresAt.getTime() <= now.getTime()) {
      return null;
    }

    if (row.actor_id === null) {
      return {
        sessionId: row.id,
        token,
        expiresAt,
        actorId: LEGACY_ADMIN_ACTOR_ID,
        role: "Admin",
      };
    }
    if (row.actor_id === LEGACY_ADMIN_ACTOR_ID) {
      return {
        sessionId: row.id,
        token,
        expiresAt,
        actorId: LEGACY_ADMIN_ACTOR_ID,
        role: "Admin",
      };
    }

    const status = await findOperatorStatusById(this.pool, row.actor_id);
    if (status !== "active") {
      return null;
    }
    return {
      sessionId: row.id,
      token,
      expiresAt,
      actorId: row.actor_id,
      role: "Operator",
    };
  }

  /** Beendet eine Sitzung; ein unbekanntes Token ist kein Fehler. */
  async logout(token: string): Promise<void> {
    if (!isValidOpaqueToken(token)) {
      return;
    }
    await deleteAdminSessionByTokenHash(this.pool, hashToken(token));
  }

  /**
   * Legt ein persistentes Operatorkonto an. Passwort-Hash, Konto und Audit
   * entstehen auf demselben Transaktionsclient; ein Auditfehler rollt beides
   * zurueck. Doppelte normalisierte Kennungen ergeben 409.
   */
  async createOperator(input: CreateOperatorInput): Promise<CreatedOperator> {
    const username = normalizeOperatorUsername(input.username);
    const password = validateOperatorPassword(input.password);
    const actorId = normalizeActorId(input.actorId);
    const requestId = normalizeRequestId(input.requestId);
    const at = this.now();
    const operatorId = randomUUID();
    const passwordHash = await hashPassword(password, {
      params: OPERATOR_SCRYPT_PARAMS,
      salt: randomBytes(OPERATOR_SALT_BYTES),
    });

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await insertOperator(client, {
        actorId: operatorId,
        username,
        passwordHash,
        createdAt: at,
      });
      const audit = new AuditService({ executor: client, now: this.now });
      await audit.record({
        actorType: "admin",
        actorId,
        action: AUDIT_ACTIONS.operatorCreated,
        targetType: "operator",
        targetId: operatorId,
        details:
          requestId === undefined
            ? { username }
            : { username, request_id: requestId },
      });
      await client.query("commit");
      return { operator_id: operatorId, username, status: "active" };
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // Der urspruengliche Fehler bleibt massgeblich.
      }
      if (isUniqueViolation(error)) {
        throw conflict();
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Sperrt ein Konto und schreibt Audit atomar. Die Wiederholung findet keine
   * aktive Zeile mehr und liefert 409 ohne zweiten Audit-Eintrag.
   */
  async disableOperator(input: DisableOperatorInput): Promise<void> {
    const operatorId = normalizeOperatorId(input.operatorId);
    const actorId = normalizeActorId(input.actorId);
    const requestId = normalizeRequestId(input.requestId);
    const at = this.now();

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const operator = await findOperatorForUpdate(client, operatorId);
      if (operator === null) {
        throw ApiError.notFound();
      }
      if (operator.status === "disabled") {
        throw conflict();
      }
      const changed = await markOperatorDisabled(client, operatorId, at);
      if (changed !== 1) {
        throw conflict();
      }
      const audit = new AuditService({ executor: client, now: this.now });
      await audit.record({
        actorType: "admin",
        actorId,
        action: AUDIT_ACTIONS.operatorDisabled,
        targetType: "operator",
        targetId: operatorId,
        details:
          requestId === undefined
            ? { username: operator.username, status: "disabled" }
            : {
                username: operator.username,
                status: "disabled",
                request_id: requestId,
              },
      });
      await client.query("commit");
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // Der urspruengliche Fehler bleibt massgeblich.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
