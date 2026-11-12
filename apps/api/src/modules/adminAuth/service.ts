import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AppConfig } from "../../config.js";
import { verifyPassword } from "../../crypto/password.js";
import {
  generateAdminSessionToken,
  hashToken,
  isValidOpaqueToken,
} from "../../crypto/tokens.js";
import { ApiError } from "../../http/errors.js";
import { AUDIT_ACTIONS, insertAuditEvent } from "../audit/repository.js";
import {
  deleteAdminSessionByTokenHash,
  findAdminSessionByTokenHash,
  insertAdminSession,
} from "./repository.js";

/** Kontext einer gueltigen Admin-Sitzung (nur nach Cookie-Pruefung). */
export interface AdminSessionContext {
  sessionId: string;
  /** Klartext-Token; nur zum Loeschen beim Logout benoetigt. */
  token: string;
  expiresAt: Date;
}

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
 * Admin-Anmeldung und Sitzungsverwaltung (API-VERTRAG.md Abschnitt 5,
 * ARCHITEKTUR.md Abschnitt 4). Das Passwort wird nur zeitkonstant gegen den
 * scrypt-Hash aus der Umgebung geprueft; Sitzungstokens liegen nur als Hash
 * in der Datenbank.
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
   * Sitzung; der Fehlversuch wird audit- und rate-limitiert (Aufrufer).
   */
  async login(password: string): Promise<AdminLoginResult> {
    const now = this.now();
    const valid = await verifyPassword(password, this.config.adminPasswordHash);

    if (!valid) {
      await insertAuditEvent(this.pool, {
        at: now,
        actorType: "admin",
        actorId: ADMIN_ACTOR_ID,
        action: AUDIT_ACTIONS.adminLoginFailed,
        details: {},
      });
      throw ApiError.unauthorized();
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
    });
    await insertAuditEvent(this.pool, {
      at: now,
      actorType: "admin",
      actorId: ADMIN_ACTOR_ID,
      action: AUDIT_ACTIONS.adminLoginSucceeded,
      details: {},
    });

    return { token, expiresAt };
  }

  /**
   * Prueft ein Sitzungstoken bei jeder Anfrage. Unbekannt, abgelaufen oder
   * formal ungueltig ergibt null; der Aufrufer antwortet mit 401.
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
    return { sessionId: row.id, token, expiresAt };
  }

  /** Beendet eine Sitzung; ein unbekanntes Token ist kein Fehler. */
  async logout(token: string): Promise<void> {
    if (!isValidOpaqueToken(token)) {
      return;
    }
    await deleteAdminSessionByTokenHash(this.pool, hashToken(token));
  }
}
