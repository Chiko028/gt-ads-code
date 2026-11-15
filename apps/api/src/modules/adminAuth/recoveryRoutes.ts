/**
 * CX-066 / R-605: HTTP-Integration des Wiederherstellungskerns aus CX-065.
 *
 * Zwei Routen, beide ausschliesslich innerhalb der bestehenden
 * Admin-Sicherheitsverwaltung (Aktion security.manage, nur Admin):
 *
 * - POST /v1/admin/auth/recovery/verify
 *   Ersetzt den zweiten Faktor durch einen einmaligen Wiederherstellungscode.
 *   Voraussetzung ist dieselbe gueltige Admin-Passwort-Vorsitzung wie bei
 *   TOTP (Sitzungscookie aus POST /v1/admin/login). Der Code, die Challenge,
 *   die rotierte Sitzung und das Erfolgsaudit committen gemeinsam; das neue
 *   Cookie wird erst nach dem Commit gesetzt.
 *
 * - POST /v1/admin/auth/recovery-codes
 *   Erzeugt oder ersetzt den Codesatz. Voraussetzung ist eine vollstaendige
 *   MFA-Sitzung (mfa_verified_at gesetzt) plus ein erneut eingegebener,
 *   frischer TOTP-Code aus dem bestaetigten aktiven TOTP-Zustand des
 *   MFA-Kerns. Die Replay-Sperre wird in derselben Transaktion
 *   fortgeschrieben. Die neuen Klartextcodes erscheinen genau einmal in der
 *   Antwort (Cache-Control: no-store); es gibt keine lesende Code-API.
 *
 * Bewusst nicht enthalten: Secret-Austausch, MFA-Deaktivierung,
 * Bootstrap-Bypass, Passwort-/TOTP-Reset und eine Produktionsaktivierung
 * (die Routen werden von server.ts nicht registriert).
 *
 * Persistenz: Der Kern CX-065 besitzt bereits Codesaetze und Codes. Fuer die
 * HTTP-Integration kommen zwei additive, modul-eigene Tabellen (Challenge und
 * TOTP-Replay-Zustand) sowie die additive Spalte admin_sessions.mfa_verified_at
 * hinzu. Sie werden wie die uebrigen modul-eigenen Schemata idempotent beim
 * ersten Zugriff angelegt; es entsteht keine Migration und keine Aenderung
 * bestehender Spalten. Nur eine Sitzung mit gesetztem mfa_verified_at gilt als
 * vollstaendige MFA-Sitzung.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../../config.js";
import { generateAdminSessionToken, hashToken } from "../../crypto/tokens.js";
import { ApiError } from "../../http/errors.js";
import { registerJsonRoute } from "../../http/jsonContract.js";
import type { RateLimiter } from "../../http/rateLimit.js";
import { insertAuditEvent } from "../audit/repository.js";
import {
  ADMIN_SESSION_COOKIE,
  createAdminSessionMiddleware,
  requireAdminWrite,
} from "./middleware.js";
import { readActiveTotpCredential } from "./activeTotpCredential.js";
import {
  consumeLoginChallenge,
  isLoginChallengeUsable,
  lockLoginChallenge,
  recordLoginChallengeFailure,
} from "./loginChallenge.js";
import {
  createRecoveryCodeService,
  issueRecoveryCodeSetInTransaction,
  type RecoveryCodeSet,
  type RecoveryCodeService,
} from "./recoveryCodes.js";
import {
  deleteAdminSessionById,
  findAdminSessionByIdForUpdate,
  insertAdminSession,
} from "./repository.js";
import {
  LEGACY_ADMIN_ACTOR_ID,
  type AdminAuthService,
  type AdminSessionContext,
} from "./service.js";
import { matchTotpStep } from "./totp.js";

export const ADMIN_MFA_RECOVERY_VERIFY_URL = "/v1/admin/auth/recovery/verify";
export const ADMIN_MFA_RECOVERY_CODES_URL = "/v1/admin/auth/recovery-codes";

/** Erfolgsaudit der rotierten Sitzung; enthaelt weder Code noch Token. */
export const ADMIN_MFA_RECOVERY_SESSION_ACTION =
  "admin.mfa.recovery.session.issued";
export const ADMIN_MFA_SESSION_TARGET_TYPE = "admin_session";

/**
 * Praefix des kontobezogenen Schluessels im vorhandenen Fehlversuchszaehler.
 * TOTP und Wiederherstellung teilen sich damit dasselbe Konto-Kontingent.
 */
export const ADMIN_MFA_ACCOUNT_LIMIT_PREFIX = "admin-mfa-account:";

/**
 * Modul-eigenes, additives Schema. Es wird idempotent beim ersten Zugriff
 * angelegt (Muster der bestehenden ensure*-Schemata) und aendert keine
 * vorhandene Tabelle.
 *
 * - admin_mfa_recovery_challenges: genau eine Challenge je Vorsitzung, mit
 *   Ablauf, Fehlversuchszaehler und den getrennten Abschluessen "verbraucht"
 *   (Erfolg) und "gesperrt" (Fehlversuchsgrenze).
 * - admin_mfa_totp_replay_state: zuletzt akzeptierter TOTP-Schritt je Konto.
 *   Das ist die persistente Replay-Sperre; sie wird nur innerhalb der
 *   Transaktion der Codesatz-Ausgabe fortgeschrieben.
 */
const MODULE_SCHEMA_SQL = [
  "create table if not exists admin_mfa_recovery_challenges (",
  "  id uuid primary key,",
  "  session_id uuid not null,",
  "  actor_id text not null check (actor_id <> ''),",
  "  created_at timestamptz not null,",
  "  expires_at timestamptz not null,",
  "  failed_attempts integer not null default 0 check (failed_attempts >= 0),",
  "  consumed_at timestamptz null,",
  "  locked_at timestamptz null,",
  "  constraint admin_mfa_recovery_challenges_window_check check (",
  "    expires_at > created_at",
  "  ),",
  "  constraint admin_mfa_recovery_challenges_close_check check (",
  "    consumed_at is null or locked_at is null",
  "  )",
  ");",
  "create unique index if not exists admin_mfa_recovery_challenges_session_idx",
  "  on admin_mfa_recovery_challenges (session_id);",
  "create table if not exists admin_mfa_totp_replay_state (",
  "  actor_id text primary key check (actor_id <> ''),",
  "  last_accepted_step bigint not null check (last_accepted_step >= 0),",
  "  updated_at timestamptz not null",
  ");",
  "alter table admin_sessions",
  "  add column if not exists mfa_verified_at timestamptz null;",
].join("\n");

export interface AdminMfaRecoveryRoutesDeps {
  pool: Pool;
  adminAuth: AdminAuthService;
  config: AppConfig;
  /**
   * Vorhandener Fehlversuchszaehler der Admin-Anmeldung. Beide Routen nutzen
   * denselben Zaehler mit quellen- und kontobezogenem Schluessel, damit ein
   * Wechsel zwischen TOTP und Wiederherstellung das Kontingent nicht umgeht.
   */
  loginLimiter: RateLimiter;
  /**
   * Exakt 32 Byte (CX-106-Schluessel) fuer das vorhandene TOTP-Geheimnis.
   * Ohne gueltigen Schluessel verweigert die Codesatz-Ausgabe generisch.
   */
  totpEncryptionKey?: Buffer | Uint8Array;
  now?: () => Date;
}

const VERIFY_BODY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["code"],
  properties: {
    code: { type: "string", minLength: 1, maxLength: 64 },
  },
};

const CODES_BODY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["totp_code"],
  properties: {
    totp_code: { type: "string", minLength: 6, maxLength: 6 },
  },
};

const ensuredPools = new WeakSet<Pool>();

/**
 * Legt das modul-eigene Schema einmal je Pool an. create table if not exists
 * ist auch bei parallelen Erstzugriffen unschaedlich.
 */
export async function ensureAdminMfaRecoverySchema(pool: Pool): Promise<void> {
  if (ensuredPools.has(pool)) {
    return;
  }
  await pool.query(MODULE_SCHEMA_SQL);
  ensuredPools.add(pool);
}

function mfaUnavailable(): ApiError {
  // Kein neuer oeffentlicher Fehlercode: fehlende Serverkonfiguration ist
  // keine Aussage ueber den uebergebenen Code.
  return new ApiError("internal_error", { statusCode: 503 });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecoveryCodeBody(body: unknown): string {
  if (!isPlainObject(body)) {
    throw ApiError.invalidRequest();
  }
  const code = body.code;
  if (typeof code !== "string" || code.length === 0 || code.length > 64) {
    throw ApiError.invalidRequest();
  }
  return code;
}

function parseTotpCodeBody(body: unknown): string {
  if (!isPlainObject(body)) {
    throw ApiError.invalidRequest();
  }
  const code = body.totp_code;
  if (typeof code !== "string" || !/^[0-9]{6}$/.test(code)) {
    throw ApiError.invalidRequest();
  }
  return code;
}

function requireAdminSession(request: FastifyRequest): AdminSessionContext {
  const session = request.adminSession;
  if (session === undefined) {
    throw ApiError.unauthorized();
  }
  // Der Rechtekern verweigert Operator bereits ueber security.manage; die
  // Pruefung bleibt als zweite, explizite Grenze erhalten.
  if (session.role !== "Admin") {
    throw ApiError.forbidden();
  }
  return session;
}

/**
 * Sicherheitskritische Routen verlangen eine vollstaendige MFA-Sitzung.
 * Eine reine Passwort-Vorsitzung (mfa_verified_at is null) wird abgelehnt.
 */
function requireMfaSession(session: AdminSessionContext): AdminSessionContext {
  if (session.mfaVerifiedAt === null) {
    throw ApiError.forbidden();
  }
  return session;
}

interface AttemptReservation {
  /** Zaehlt den Versuch als Fehlversuch (Quelle und Konto). */
  commitFailure(): void;
  /** Gibt den reservierten Platz ohne Fehlversuch frei. */
  release(): void;
}

/**
 * Reserviert atomar einen Versuch bei Quelle und Konto im vorhandenen
 * Fehlversuchszaehler. Ist eine Grenze erreicht, bleibt der andere Platz
 * nicht belegt; die Antwort ist 429 mit Retry-After.
 */
function beginAttempt(
  limiter: RateLimiter,
  sourceKey: string,
  accountKey: string,
): AttemptReservation {
  const source = limiter.reserve(sourceKey);
  if (!source.allowed) {
    throw ApiError.rateLimited(source.retryAfterSeconds);
  }
  const account = limiter.reserve(accountKey);
  if (!account.allowed) {
    source.ticket.release();
    throw ApiError.rateLimited(account.retryAfterSeconds);
  }
  const sourceTicket = source.ticket;
  const accountTicket = account.ticket;
  return {
    commitFailure: () => {
      sourceTicket.commitFailure();
      accountTicket.commitFailure();
    },
    release: () => {
      sourceTicket.release();
      accountTicket.release();
    },
  };
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("begin");
    open = true;
    const result = await operation(client);
    await client.query("commit");
    open = false;
    return result;
  } catch (error) {
    if (open) {
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

interface RotatedSession {
  token: string;
  expiresAt: Date;
}

function hasValidKey(
  key: Buffer | Uint8Array | undefined,
): key is Buffer | Uint8Array {
  return key instanceof Uint8Array && key.byteLength === 32;
}

/**
 * Registriert beide Wiederherstellungsrouten. Die Funktion registriert genau
 * einmal je App-Instanz und wird von server.ts bewusst nicht aufgerufen
 * (keine Produktionsaktivierung).
 */
export function registerAdminMfaRecoveryRoutes(
  app: FastifyInstance,
  deps: AdminMfaRecoveryRoutesDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);
  const now = deps.now ?? (() => new Date());
  const recoveryCodes: RecoveryCodeService = createRecoveryCodeService({
    pool: deps.pool,
    now,
  });
  const maxAttempts = deps.config.registrationMaxFailsPerSource;

  registerJsonRoute(app, {
    method: "POST",
    url: ADMIN_MFA_RECOVERY_VERIFY_URL,
    bodySchema: VERIFY_BODY_SCHEMA,
    onRequest: [requireAdminWrite, sessionGuard],
    handler: async (request, reply) => {
      const session = requireAdminSession(request);
      await ensureAdminMfaRecoverySchema(deps.pool);

      const attempt = beginAttempt(
        deps.loginLimiter,
        request.ip,
        ADMIN_MFA_ACCOUNT_LIMIT_PREFIX + session.actorId,
      );

      let rotated: RotatedSession | null;
      try {
        rotated = await withTransaction(deps.pool, async (client) => {
          const at = now();

          // 1) Die Vorsitzung muss noch existieren; die Zeilensperre
          //    serialisiert parallele Rotationen derselben Vorsitzung.
          const preSession = await findAdminSessionByIdForUpdate(
            client,
            session.sessionId,
          );
          if (preSession === null) {
            return null;
          }

          // 2) Dieselbe persistente Login-Challenge wie der TOTP-Zweig;
          //    die vorhandene Zeile wird gesperrt.
          const challenge = await lockLoginChallenge(
            client,
            session.sessionId,
            session.actorId,
            at,
            session.expiresAt,
          );
          if (
            challenge === null ||
            !isLoginChallengeUsable(challenge, at, maxAttempts)
          ) {
            return null;
          }

          // 3) Code verbrauchen. Der bedingte UPDATE des Kerns trifft genau
          //    einmal, auch bei parallelen Anfragen.
          const code = parseRecoveryCodeBody(request.body);
          let consumption: { consumed: boolean; codeSetId?: string };
          try {
            consumption = await recoveryCodes.consume(
              session.actorId,
              code,
              client,
            );
          } catch (error) {
            if (error instanceof ApiError) {
              // Formatfehler zaehlen wie ein falscher Code; kein Oracle.
              consumption = { consumed: false };
            } else {
              throw error;
            }
          }

          if (!consumption.consumed) {
            await recordLoginChallengeFailure(
              client,
              challenge.id,
              maxAttempts,
              at,
            );
            // Der Fehlversuch bleibt bestehen; der Aufrufer wirft 401.
            return null;
          }

          // 4) Challenge verbrauchen, Vorsitzung ersetzen, Audit schreiben.
          //    Alles im selben Commit; das Cookie folgt erst danach.
          if (!(await consumeLoginChallenge(client, challenge.id, at))) {
            throw new Error("Challenge konnte nicht verbraucht werden");
          }

          const removed = await deleteAdminSessionById(
            client,
            session.sessionId,
          );
          if (removed !== 1) {
            throw new Error("Vorsitzung konnte nicht ersetzt werden");
          }

          const token = generateAdminSessionToken();
          const sessionExpiresAt = new Date(
            at.getTime() + deps.config.adminSessionTtlSeconds * 1000,
          );
          await insertAdminSession(client, {
            id: randomUUID(),
            tokenHash: hashToken(token),
            createdAt: at,
            expiresAt: sessionExpiresAt,
            mfaVerifiedAt: at,
            // Legacy-Sitzungen bleiben ohne actor_id; Operator-Sitzungen
            // tragen ihre persistente UUID.
            actorId:
              session.actorId === LEGACY_ADMIN_ACTOR_ID
                ? null
                : session.actorId,
          });
          await insertAuditEvent(client, {
            at,
            actorType: "admin",
            actorId: session.actorId,
            action: ADMIN_MFA_RECOVERY_SESSION_ACTION,
            targetType: ADMIN_MFA_SESSION_TARGET_TYPE,
            targetId: session.sessionId,
            details: {
              rotated_session_id: session.sessionId,
              code_set_id: consumption.codeSetId ?? null,
            },
          });

          return { token, expiresAt: sessionExpiresAt };
        });
      } catch (error) {
        // Unerwartete Fehler (z. B. Auditfehler) zaehlen nicht als
        // Fehlversuch; die Transaktion ist vollstaendig zurueckgerollt.
        attempt.release();
        throw error;
      }

      if (rotated === null) {
        attempt.commitFailure();
        throw ApiError.unauthorized();
      }

      attempt.release();
      reply.header("Cache-Control", "no-store");
      reply.setCookie(ADMIN_SESSION_COOKIE, rotated.token, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        secure: deps.config.cookieSecure,
        maxAge: deps.config.adminSessionTtlSeconds,
      });
      reply.code(204).send();
    },
  });

  registerJsonRoute(app, {
    method: "POST",
    url: ADMIN_MFA_RECOVERY_CODES_URL,
    bodySchema: CODES_BODY_SCHEMA,
    onRequest: [requireAdminWrite, sessionGuard],
    handler: async (request, reply) => {
      const key = deps.totpEncryptionKey;
      if (!hasValidKey(key)) {
        throw mfaUnavailable();
      }
      const session = requireMfaSession(requireAdminSession(request));
      await ensureAdminMfaRecoverySchema(deps.pool);

      // Format vor der Reservierung validieren: ein ungueltiger Wert darf
      // keine Limiter-Tickets belegen.
      const totpCode = parseTotpCodeBody(request.body);

      const attempt = beginAttempt(
        deps.loginLimiter,
        request.ip,
        ADMIN_MFA_ACCOUNT_LIMIT_PREFIX + session.actorId,
      );

      type CodesOutcome =
        | { kind: "issued"; set: RecoveryCodeSet }
        | { kind: "wrong" }
        | { kind: "blocked" };

      let outcome: CodesOutcome;
      try {
        outcome = await withTransaction<CodesOutcome>(
          deps.pool,
          async (client) => {
            const at = now();

            // 1) Dieselbe persistente Login-Challenge wie der
            //    Wiederherstellungszweig; Sperre und Fehlversuchszaehler
            //    gelten damit fuer beide zweiten Faktoren gemeinsam.
            const challenge = await lockLoginChallenge(
              client,
              session.sessionId,
              session.actorId,
              at,
              session.expiresAt,
            );
            if (
              challenge === null ||
              !isLoginChallengeUsable(challenge, at, maxAttempts)
            ) {
              return { kind: "blocked" };
            }

            // 2) Ausschliesslich der bestaetigte aktive TOTP-Zustand des
            //    MFA-Kerns; eine ausstehende Einrichtung ist kein Nachweis.
            const credential = await readActiveTotpCredential(
              client,
              key,
              session.actorId,
            );
            if (credential === null) {
              return { kind: "blocked" };
            }
            const step = matchTotpStep(
              credential.secret,
              totpCode,
              at.getTime(),
              credential.lastAcceptedStep,
            );
            if (step === null) {
              await recordLoginChallengeFailure(
                client,
                challenge.id,
                maxAttempts,
                at,
              );
              return { kind: "wrong" };
            }

            // 3) Replay-Sperre fortschreiben. Der bedingte Upsert akzeptiert
            //    nur einen echt groesseren Schritt; ein Replay ist ebenfalls
            //    ein Fehlversuch auf derselben Challenge.
            const advanced = await client.query(
              [
                "insert into admin_mfa_totp_replay_state",
                "  (actor_id, last_accepted_step, updated_at)",
                "values ($1, $2, $3)",
                "on conflict (actor_id) do update",
                "   set last_accepted_step = excluded.last_accepted_step,",
                "       updated_at = excluded.updated_at",
                " where admin_mfa_totp_replay_state.last_accepted_step",
                "       < excluded.last_accepted_step",
                "returning last_accepted_step",
              ].join("\n"),
              [session.actorId, step, at],
            );
            if ((advanced.rowCount ?? 0) !== 1) {
              await recordLoginChallengeFailure(
                client,
                challenge.id,
                maxAttempts,
                at,
              );
              return { kind: "wrong" };
            }

            // 4) Codesatz erzeugen/ersetzen und Audit in derselben
            //    Transaktion.
            return {
              kind: "issued",
              set: await issueRecoveryCodeSetInTransaction(
                client,
                session.actorId,
                { now: () => at },
              ),
            };
          },
        );
      } catch (error) {
        attempt.release();
        throw error;
      }

      if (outcome.kind !== "issued") {
        if (outcome.kind === "wrong") {
          attempt.commitFailure();
        } else {
          attempt.release();
        }
        throw ApiError.unauthorized();
      }

      attempt.release();
      reply.header("Cache-Control", "no-store");
      reply.code(200).send({
        codes: outcome.set.codes,
        created_at: outcome.set.createdAt.toISOString(),
      });
    },
  });
}
