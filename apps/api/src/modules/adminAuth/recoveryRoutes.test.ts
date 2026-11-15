/**
 * CX-066 / R-605: HTTP-Integration des Wiederherstellungskerns aus CX-065.
 *
 * Die Tests laufen gegen echte Fastify-Instanzen, eine echte
 * PostgreSQL-Datenbank, echte Admin-Sitzungscookies und die vorhandenen
 * Kerne (CX-015-Rechtekern, CX-017-TOTP, CX-065-Wiederherstellungscodes,
 * CX-106-Einrichtungsspeicher). Es gibt keine Mocks fuer Authentifizierung,
 * Persistenz oder Audit; alle Kennungen, Passwoerter und Codes sind
 * synthetisch.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { CONFIG_DEFAULTS, type AppConfig } from "../../config.js";
import { hashPassword } from "../../crypto/password.js";
import { migrateUp } from "../../db/migrate.js";
import { installAccessControl } from "../../http/authorization.js";
import { registerErrorHandler } from "../../http/errors.js";
import { redactUrl } from "../../http/logging.js";
import { createLegacyAdminPrincipalResolver } from "../../http/principal.js";
import { RateLimiter } from "../../http/rateLimit.js";
import { ADMIN_SESSION_COOKIE } from "./middleware.js";
import { encryptActiveTotpSecret } from "./activeTotpCredential.js";
import {
  RECOVERY_CODE_SET_CREATED_ACTION,
  RECOVERY_CODE_SET_REPLACED_ACTION,
  RECOVERY_CODE_USED_ACTION,
  createRecoveryCodeService,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from "./recoveryCodes.js";
import {
  ADMIN_MFA_RECOVERY_CODES_URL,
  ADMIN_MFA_RECOVERY_SESSION_ACTION,
  ADMIN_MFA_RECOVERY_VERIFY_URL,
  ensureAdminMfaRecoverySchema,
  registerAdminMfaRecoveryRoutes,
} from "./recoveryRoutes.js";
import {
  createAdminLoginRateLimiter,
  registerAdminAuthRoutes,
} from "./routes.js";
import {
  AdminAuthService,
  LEGACY_ADMIN_ACTOR_ID,
  OPERATOR_SCRYPT_PARAMS,
} from "./service.js";
import { generateTotpSecret } from "./totp.js";
import { ensureAdminTotpConfirmSchema } from "./totpSetupConfirm.js";
import {
  ADMIN_MFA_TOTP_LOGIN_URL,
  registerAdminTotpLoginRoutes,
} from "./totpLogin.js";

const BASE_TIME = Date.parse("2026-11-15T09:00:00.000Z");
const TOTP_STEP_MS = 30_000;
const ADMIN_PASSWORD = "SYN-CX066-Admin-Passwort";
const OPERATOR_PASSWORD = "SYN-CX066-Operator-Passwort";
const OPERATOR_USERNAME = "syn-cx066-operator";
const HOST = "127.0.0.1:8080";
const ORIGIN = "http://" + HOST;
const FOREIGN_ORIGIN = "http://fremde.example";
const JSON_HEADERS = { "content-type": "application/json" };
const TOTP_KEY = randomBytes(32);

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);

/** RFC-4648-Base32 und HMAC-SHA1 unabhaengig von der Implementierung. */
const REFERENCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function referenceDecodeBase32(secret: string): Buffer {
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of secret) {
    accumulator = ((accumulator << 5) | REFERENCE_ALPHABET.indexOf(character)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function referenceTotpStep(secretBase32: string, step: number): string {
  const key = referenceDecodeBase32(secretBase32);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[19] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return ((binary >>> 0) % 1_000_000).toString(10).padStart(6, "0");
}

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
const openApps: FastifyInstance[] = [];
const logLines: string[] = [];

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

function baseConnection(): {
  host: string;
  port: number;
  user: string;
  database: string;
} {
  const host = process.env.PGHOST;
  const user = process.env.PGUSER;
  const database = process.env.PGDATABASE;
  if (host === undefined || user === undefined || database === undefined) {
    throw new Error("CX-066 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

let currentTimeMs = BASE_TIME;

function clock(): Date {
  return new Date(currentTimeMs);
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx066_" +
    process.pid +
    "_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 8)
  )
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(databaseName));

  pool = new Pool({ ...base, database: databaseName });
  await migrateUp(pool);
  for (const file of (await readdir(MIGRATIONS_DIR)).sort()) {
    if (!file.endsWith(".up.sql") || file === "0001_gt_ads_001.up.sql") {
      continue;
    }
    await pool.query(await readFile(join(MIGRATIONS_DIR, file), "utf8"));
  }
  await ensureAdminMfaRecoverySchema(pool);
  await ensureAdminTotpConfirmSchema(pool);

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX066-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };

  await pool.query(
    [
      "insert into operators",
      "  (actor_id, username, password_hash, status, created_at, disabled_at)",
      "values ($1::uuid, $2, $3, 'active', $4, null)",
    ].join("\n"),
    [
      randomUUID(),
      OPERATOR_USERNAME,
      await hashPassword(OPERATOR_PASSWORD, {
        params: OPERATOR_SCRYPT_PARAMS,
        salt: randomBytes(16),
      }),
      new Date(BASE_TIME - 86_400_000),
    ],
  );
}, 120_000);

beforeEach(async () => {
  currentTimeMs = BASE_TIME;
  logLines.length = 0;
  await pool.query("drop trigger if exists cx066_fail_session_audit on audit_events");
  await pool.query("drop function if exists cx066_fail_session_audit() cascade");
  await pool.query(
    [
      "truncate table admin_mfa_recovery_codes, admin_mfa_recovery_code_sets,",
      "  admin_mfa_recovery_challenges, admin_mfa_totp_replay_state,",
      "  admin_mfa_pending_totp_enrollments, admin_sessions, audit_events",
      "restart identity cascade",
    ].join("\n"),
  );
});

afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await app.close();
  }
});

afterAll(async () => {
  await pool.end();
  await maintenancePool.query(
    "drop database if exists " + quoteIdentifier(databaseName),
  );
  await maintenancePool.end();
}, 60_000);

interface BuiltApp {
  app: FastifyInstance;
  limiter: RateLimiter;
}

async function buildApp(): Promise<BuiltApp> {
  const app = Fastify({
    logger: { level: "info", stream: { write: (line: string) => { logLines.push(line); } } },
    disableRequestLogging: true,
    trustProxy: false,
  });
  await app.register(cookie);
  const adminAuth = new AdminAuthService({ pool, config, now: clock });
  installAccessControl(app, {
    resolvePrincipal: createLegacyAdminPrincipalResolver(adminAuth),
  });
  registerErrorHandler(app);
  // Entspricht dem produktiven Zugriffslog (server.ts): Methode, redigierte
  // URL, Status, Dauer. Keine Bodies, Cookies oder Header.
  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        url: redactUrl(request.url),
        statusCode: reply.statusCode,
        durationMs: 0,
      },
      "request completed",
    );
  });
  const limiter = createAdminLoginRateLimiter(config, () => clock().getTime());
  registerAdminAuthRoutes(app, { service: adminAuth, loginLimiter: limiter, config });
  registerAdminMfaRecoveryRoutes(app, {
    pool,
    adminAuth,
    config,
    loginLimiter: limiter,
    totpEncryptionKey: TOTP_KEY,
    now: clock,
  });
  registerAdminTotpLoginRoutes(app, {
    pool,
    adminAuth,
    config,
    loginLimiter: limiter,
    totpEncryptionKey: TOTP_KEY,
    now: clock,
  });
  await app.ready();
  openApps.push(app);
  return { app, limiter };
}

function cookiesOf(headers: Record<string, unknown>): string | undefined {
  const raw = headers["set-cookie"];
  const first = Array.isArray(raw) ? (raw[0] as string | undefined) : (raw as string | undefined);
  return first;
}

function cookieValue(setCookie: string | undefined): string {
  expect(setCookie, "Set-Cookie fehlt").toBeTruthy();
  const value = (setCookie as string).split(";")[0] as string;
  return value.slice(value.indexOf("=") + 1);
}

async function login(
  app: FastifyInstance,
  options: { username?: string; password?: string; remoteAddress?: string } = {},
): Promise<string> {
  const payload: Record<string, string> = {
    password: options.password ?? ADMIN_PASSWORD,
  };
  if (options.username !== undefined) {
    payload.username = options.username;
  }
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, ...JSON_HEADERS },
    payload,
    remoteAddress: options.remoteAddress ?? "192.0.2.10",
  });
  expect(response.statusCode, response.body).toBe(204);
  return cookieValue(cookiesOf(response.headers as Record<string, unknown>));
}

interface RequestOptions {
  cookie?: string | null;
  origin?: string;
  remoteAddress?: string;
}

function adminHeaders(options: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = { host: HOST, ...JSON_HEADERS };
  if (options.origin !== undefined) {
    headers.origin = options.origin;
  }
  if (options.cookie !== undefined && options.cookie !== null) {
    headers.cookie = ADMIN_SESSION_COOKIE + "=" + options.cookie;
  }
  return headers;
}

async function verifyRequest(
  app: FastifyInstance,
  code: string,
  options: RequestOptions = {},
): Promise<{ statusCode: number; headers: Record<string, unknown>; body: string }> {
  const response = await app.inject({
    method: "POST",
    url: ADMIN_MFA_RECOVERY_VERIFY_URL,
    headers: adminHeaders(options),
    payload: { code },
    remoteAddress: options.remoteAddress ?? "192.0.2.11",
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers as Record<string, unknown>,
    body: response.body,
  };
}

async function codesRequest(
  app: FastifyInstance,
  totpCode: string,
  options: RequestOptions = {},
): Promise<{ statusCode: number; headers: Record<string, unknown>; body: string }> {
  const response = await app.inject({
    method: "POST",
    url: ADMIN_MFA_RECOVERY_CODES_URL,
    headers: adminHeaders(options),
    payload: { totp_code: totpCode },
    remoteAddress: options.remoteAddress ?? "192.0.2.12",
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers as Record<string, unknown>,
    body: response.body,
  };
}

async function totpLoginRequest(
  app: FastifyInstance,
  totpCode: string,
  options: RequestOptions = {},
): Promise<{ statusCode: number; headers: Record<string, unknown>; body: string }> {
  const response = await app.inject({
    method: "POST",
    url: ADMIN_MFA_TOTP_LOGIN_URL,
    headers: adminHeaders(options),
    payload: { totp_code: totpCode },
    remoteAddress: options.remoteAddress ?? "192.0.2.13",
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers as Record<string, unknown>,
    body: response.body,
  };
}

/**
 * Legt den bestaetigten aktiven TOTP-Zustand direkt in derselben
 * Verschluesselung ab, die CX-108 beim Abschluss der Einrichtung verwendet.
 */
async function activateTotpDirectly(
  secret: string,
  lastAcceptedStep: number,
): Promise<void> {
  const enrollmentId = randomUUID();
  const encrypted = encryptActiveTotpSecret(
    TOTP_KEY,
    LEGACY_ADMIN_ACTOR_ID,
    enrollmentId,
    secret,
  );
  await pool.query(
    [
      "insert into admin_mfa_totp_replay_state",
      "  (actor_id, last_accepted_step, updated_at, enrollment_id,",
      "   nonce, ciphertext, tag, activated_at)",
      "values ($1, $2, $3, $4::uuid, $5, $6, $7, $3)",
      "on conflict (actor_id) do update",
      "   set last_accepted_step = excluded.last_accepted_step,",
      "       updated_at = excluded.updated_at,",
      "       enrollment_id = excluded.enrollment_id,",
      "       nonce = excluded.nonce,",
      "       ciphertext = excluded.ciphertext,",
      "       tag = excluded.tag,",
      "       activated_at = excluded.activated_at",
    ].join("\n"),
    [
      LEGACY_ADMIN_ACTOR_ID,
      lastAcceptedStep,
      clock(),
      enrollmentId,
      encrypted.nonce,
      encrypted.ciphertext,
      encrypted.tag,
    ],
  );
}

async function issueSetDirectly(actorId: string = LEGACY_ADMIN_ACTOR_ID): Promise<string[]> {
  const service = createRecoveryCodeService({ pool, now: clock });
  const created = await service.create(actorId);
  return created.codes;
}

async function scalar(query: string, values: unknown[] = []): Promise<number> {
  const result = await pool.query<{ count: string }>(query, values);
  return Number(result.rows[0]?.count ?? "0");
}

/** Liest genau einen numerischen Spaltenwert (z. B. Zaehler oder Schritt). */
async function numberValue(
  query: string,
  column: string,
  values: unknown[] = [],
): Promise<number> {
  const result = await pool.query<Record<string, string | number>>(query, values);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Erwartete Zeile fehlt: " + column);
  }
  return Number(row[column]);
}

function bareCode(displayed: string): string {
  return displayed.replace(/-/g, "");
}

function badRecoveryCode(): string {
  // Gueltiges Format, aber kein gespeicherter Code.
  return "0000-0000-0000-0000-0000-0000-0000-0001";
}

describe("CX-066 Wiederherstellung als zweiter Faktor", () => {
  it("gültige Admin-Passwort-Vorsitzung plus unverbrauchter Wiederherstellungscode erzeugt genau eine rotierte MFA-Sitzung; ohne Vorsitzung, als Operator und mit abgelaufener Challenge wird verweigert.", async () => {
    const { app } = await buildApp();
    const codes = await issueSetDirectly();
    const preSessionCookie = await login(app);

    const rotated = await verifyRequest(app, codes[0] as string, {
      cookie: preSessionCookie,
      remoteAddress: "192.0.2.21",
    });
    expect(rotated.statusCode, rotated.body).toBe(204);
    expect(rotated.headers["cache-control"]).toBe("no-store");
    const rotatedCookie = cookieValue(cookiesOf(rotated.headers));
    expect(rotatedCookie).not.toBe(preSessionCookie);

    // Genau eine Sitzung: die Vorsitzung ist ersetzt, nicht ergaenzt.
    expect(
      await scalar("select count(*) from admin_sessions"),
    ).toBe(1);
    // Code und Challenge sind verbraucht.
    expect(
      await scalar(
        "select count(*) from admin_mfa_recovery_codes where used_at is not null",
      ),
    ).toBe(1);
    expect(
      await scalar(
        "select count(*) from admin_mfa_recovery_challenges where consumed_at is not null",
      ),
    ).toBe(1);
    // Erfolgsaudit ohne Geheimnis.
    const audit = await pool.query<{ details: Record<string, unknown> }>(
      "select details from audit_events where action = $1",
      [ADMIN_MFA_RECOVERY_SESSION_ACTION],
    );
    expect(audit.rowCount).toBe(1);
    expect(JSON.stringify(audit.rows[0]?.details)).not.toContain(bareCode(codes[0] as string));

    // Die alte Vorsitzung ist ungueltig, die rotierte Sitzung gilt.
    const replayWithOldCookie = await verifyRequest(app, codes[1] as string, {
      cookie: preSessionCookie,
      remoteAddress: "192.0.2.22",
    });
    expect(replayWithOldCookie.statusCode).toBe(401);
    const withRotatedCookie = await verifyRequest(app, codes[1] as string, {
      cookie: rotatedCookie,
      remoteAddress: "192.0.2.23",
    });
    expect(withRotatedCookie.statusCode, withRotatedCookie.body).toBe(204);

    // Ohne Vorsitzung.
    const anonymous = await verifyRequest(app, codes[2] as string, {
      remoteAddress: "192.0.2.24",
    });
    expect(anonymous.statusCode).toBe(401);

    // Als Operator (gueltige Sitzung, aber kein Adminrecht).
    const operatorCookie = await login(app, {
      username: OPERATOR_USERNAME,
      password: OPERATOR_PASSWORD,
      remoteAddress: "192.0.2.25",
    });
    const asOperator = await verifyRequest(app, codes[2] as string, {
      cookie: operatorCookie,
      remoteAddress: "192.0.2.25",
    });
    expect(asOperator.statusCode).toBe(403);

    // Abgelaufene Challenge: eine Challenge existiert, ist aber nicht mehr
    // gueltig; Code und Challenge bleiben unverbraucht.
    const expiredCookie = await login(app, { remoteAddress: "192.0.2.26" });
    const wrong = await verifyRequest(app, badRecoveryCode(), {
      cookie: expiredCookie,
      remoteAddress: "192.0.2.26",
    });
    expect(wrong.statusCode).toBe(401);
    await pool.query(
      [
        "update admin_mfa_recovery_challenges",
        "   set created_at = $1, expires_at = $2",
        " where created_at = $3",
      ].join("\n"),
      [
        new Date(BASE_TIME - 120_000),
        new Date(BASE_TIME - 60_000),
        new Date(BASE_TIME),
      ],
    );
    const expired = await verifyRequest(app, codes[2] as string, {
      cookie: expiredCookie,
      remoteAddress: "192.0.2.26",
    });
    expect(expired.statusCode).toBe(401);
    const unused = normalizeRecoveryCode(codes[2] as string) as string;
    expect(
      await scalar(
        "select count(*) from admin_mfa_recovery_codes where code_hash = $1 and used_at is null",
        [hashRecoveryCode(LEGACY_ADMIN_ACTOR_ID, unused)],
      ),
    ).toBe(1);
    expect(
      await scalar(
        "select count(*) from admin_mfa_recovery_challenges where consumed_at is null",
      ),
    ).toBe(1);
  });

  it("Parallele HTTP-Anfragen mit demselben Code ergeben höchstens eine Sitzung; bei Auditfehler bleiben Code und Challenge unverbraucht und es wird keine Sitzung ausgestellt.", async () => {
    const { app } = await buildApp();
    const codes = await issueSetDirectly();
    const description = (await pool.query<{ id: string; code_set_id: string }>(
      "select id::text as id, code_set_id::text as code_set_id from admin_mfa_recovery_codes where code_hash = $1",
      [hashRecoveryCode(LEGACY_ADMIN_ACTOR_ID, normalizeRecoveryCode(codes[0] as string) as string)],
    )).rows[0];

    // Auditfehler erzwingen: der Trigger schlaegt nur beim Erfolgsaudit der
    // Sitzungsrotation fehl.
    await pool.query(
      [
        "create function cx066_fail_session_audit() returns trigger",
        "language plpgsql as $$",
        "begin",
        "  if new.action = '" + ADMIN_MFA_RECOVERY_SESSION_ACTION + "' then",
        "    raise exception 'synthetischer Auditfehler';",
        "  end if;",
        "  return new;",
        "end",
        "$$",
      ].join("\n"),
    );
    await pool.query(
      "create trigger cx066_fail_session_audit before insert on audit_events for each row execute function cx066_fail_session_audit()",
    );

    const preSessionCookie = await login(app);
    const failed = await verifyRequest(app, codes[0] as string, {
      cookie: preSessionCookie,
      remoteAddress: "192.0.2.31",
    });
    expect(failed.statusCode, failed.body).toBe(500);
    expect(JSON.parse(failed.body).error.code).toBe("internal_error");

    // Nichts ist verbraucht, keine Sitzung entstanden, kein Audit.
    expect(
      await scalar("select count(*) from admin_mfa_recovery_codes where used_at is not null"),
    ).toBe(0);
    expect(
      await scalar("select count(*) from admin_mfa_recovery_challenges where consumed_at is not null"),
    ).toBe(0);
    expect(
      await scalar(
        "select count(*) from admin_mfa_recovery_challenges where failed_attempts <> 0",
      ),
    ).toBe(0);
    expect(await scalar("select count(*) from admin_sessions")).toBe(1);
    expect(
      await scalar("select count(*) from audit_events where action = $1", [
        ADMIN_MFA_RECOVERY_SESSION_ACTION,
      ]),
    ).toBe(0);
    expect(
      await scalar("select count(*) from audit_events where action = $1", [
        RECOVERY_CODE_USED_ACTION,
      ]),
    ).toBe(0);
    expect(description).toBeDefined();

    await pool.query("drop trigger cx066_fail_session_audit on audit_events");
    await pool.query("drop function cx066_fail_session_audit() cascade");

    // Zwei parallele Anfragen mit demselben Code und derselben Vorsitzung.
    const [first, second] = await Promise.all([
      verifyRequest(app, codes[0] as string, {
        cookie: preSessionCookie,
        remoteAddress: "192.0.2.32",
      }),
      verifyRequest(app, codes[0] as string, {
        cookie: preSessionCookie,
        remoteAddress: "192.0.2.33",
      }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([204, 401]);
    expect(await scalar("select count(*) from admin_sessions")).toBe(1);
    expect(
      await scalar("select count(*) from admin_mfa_recovery_codes where used_at is not null"),
    ).toBe(1);
    expect(
      await scalar("select count(*) from admin_mfa_recovery_challenges where consumed_at is not null"),
    ).toBe(1);
  });

  it("Fünf Fehlversuche sperren die gemeinsame Challenge; TOTP- und Wiederherstellungsfehler teilen Zähler und konto-/quellenbezogene Limits.", async () => {
    const { app } = await buildApp();
    const codes = await issueSetDirectly();
    const secret = generateTotpSecret();
    const step = Math.floor(BASE_TIME / TOTP_STEP_MS);
    await activateTotpDirectly(secret, step - 1);
    const wrongTotpCode = referenceTotpStep(secret, step + 10);
    const cookie = await login(app, { remoteAddress: "192.0.2.41" });

    // Zwei Fehlversuche ueber die Wiederherstellung, drei ueber die
    // tatsaechliche TOTP-Anmelderoute: dieselbe Challenge, derselbe Zaehler
    // und dieselben Schluessel.
    for (let index = 0; index < 2; index += 1) {
      const response = await verifyRequest(app, badRecoveryCode(), {
        cookie,
        remoteAddress: "192.0.2.41",
      });
      expect(response.statusCode).toBe(401);
    }
    for (let index = 0; index < 3; index += 1) {
      const response = await totpLoginRequest(app, wrongTotpCode, {
        cookie,
        remoteAddress: "192.0.2.41",
      });
      expect(response.statusCode, response.body).toBe(401);
    }

    // Der sechste Versuch ist begrenzt; Retry-After stammt aus dem Fenster.
    const limited = await totpLoginRequest(app, wrongTotpCode, {
      cookie,
      remoteAddress: "192.0.2.41",
    });
    expect(limited.statusCode).toBe(429);
    expect(JSON.parse(limited.body).error.code).toBe("rate_limited");
    const retryAfter = Number(limited.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);

    // Genau fuenf Fehlversuche, verteilt auf beide zweiten Faktoren, haben
    // die eine Challenge gesperrt.
    expect(
      await scalar(
        "select count(*) from admin_mfa_recovery_challenges where locked_at is not null and failed_attempts = 5",
      ),
    ).toBe(1);
    expect(
      await scalar(
        "select count(*) from admin_mfa_recovery_challenges where locked_at is null",
      ),
    ).toBe(0);

    // Fuenf Fehlversuche ueber die Wiederherstellung sperren die Challenge.
    // Frischer Limiter (neue App), damit die Sperre aus der Datenbank kommt.
    const fresh = await buildApp();
    const freshCookie = await login(fresh.app, { remoteAddress: "192.0.2.51" });
    for (let index = 0; index < 5; index += 1) {
      const response = await verifyRequest(fresh.app, badRecoveryCode(), {
        cookie: freshCookie,
        remoteAddress: "192.0.2.51",
      });
      expect(response.statusCode, response.body).toBe(401);
    }
    expect(
      await scalar(
        "select count(*) from admin_mfa_recovery_challenges where locked_at is not null and failed_attempts = 5",
      ),
    ).toBe(2);

    // Auch mit frischem Limiter bleibt die gesperrte Challenge derselben
    // Vorsitzung gesperrt; der gueltige Code bleibt unverbraucht. Ein neues
    // Passwort-Login erzeugt bewusst eine neue Challenge.
    const second = await buildApp();
    const blocked = await verifyRequest(second.app, codes[0] as string, {
      cookie: freshCookie,
      remoteAddress: "192.0.2.61",
    });
    expect(blocked.statusCode).toBe(401);
    expect(
      await scalar(
        "select count(*) from admin_mfa_recovery_codes where code_hash = $1 and used_at is null",
        [
          hashRecoveryCode(
            LEGACY_ADMIN_ACTOR_ID,
            normalizeRecoveryCode(codes[0] as string) as string,
          ),
        ],
      ),
    ).toBe(1);
  });

  it("Codesatz-Ausgabe verlangt vollständige MFA-Sitzung und frischen, replaygeschützten TOTP-Code; reine Passwort-Vorsitzung mit gültigem TOTP wird abgelehnt.", async () => {
    const { app } = await buildApp();
    const secret = generateTotpSecret();
    const step = Math.floor(BASE_TIME / TOTP_STEP_MS);
    await activateTotpDirectly(secret, step - 1);

    const freshCode = referenceTotpStep(secret, step);
    const nextCode = referenceTotpStep(secret, step + 1);
    const wrongCode = referenceTotpStep(secret, step + 10);

    // Ohne Sitzung und als Operator wird verweigert.
    const anonymous = await codesRequest(app, freshCode, { remoteAddress: "192.0.2.71" });
    expect(anonymous.statusCode).toBe(401);

    const cookie = await login(app, { remoteAddress: "192.0.2.72" });
    const operatorCookie = await login(app, {
      username: OPERATOR_USERNAME,
      password: OPERATOR_PASSWORD,
      remoteAddress: "192.0.2.73",
    });
    const asOperator = await codesRequest(app, freshCode, {
      cookie: operatorCookie,
      remoteAddress: "192.0.2.73",
    });
    expect(asOperator.statusCode).toBe(403);

    // Review #2: Eine reine Passwort-Vorsitzung mit gueltigem frischem
    // TOTP-Code ist noch keine vollstaendige MFA-Sitzung und darf keinen
    // Codesatz ausgeben.
    const passwordOnly = await codesRequest(app, freshCode, {
      cookie,
      remoteAddress: "192.0.2.72",
    });
    expect(passwordOnly.statusCode).toBe(403);
    expect(
      await scalar("select count(*) from admin_mfa_recovery_code_sets"),
    ).toBe(0);
    expect(
      await scalar("select count(*) from admin_mfa_recovery_challenges"),
    ).toBe(0);

    // Vollstaendige MFA-Sitzung ueber die tatsaechliche TOTP-Anmelderoute.
    const loggedIn = await totpLoginRequest(app, freshCode, {
      cookie,
      remoteAddress: "192.0.2.72",
    });
    expect(loggedIn.statusCode, loggedIn.body).toBe(204);
    expect(loggedIn.headers["cache-control"]).toBe("no-store");
    const mfaCookie = cookieValue(cookiesOf(loggedIn.headers));
    expect(mfaCookie).not.toBe(cookie);
    expect(
      await scalar("select count(*) from admin_sessions where mfa_verified_at is not null"),
    ).toBe(1);
    // Die Legacy-Vorsitzung wurde ersetzt; die Operator-Sitzung aus dem
    // vorherigen Negativtest bleibt bestehen und hat keinen MFA-Nachweis.
    expect(
      await scalar("select count(*) from admin_sessions where actor_id is null"),
    ).toBe(1);
    expect(await scalar("select count(*) from admin_sessions")).toBe(2);

    const wrong = await codesRequest(app, wrongCode, {
      cookie: mfaCookie,
      remoteAddress: "192.0.2.72",
    });
    expect(wrong.statusCode).toBe(401);
    expect(
      await scalar("select count(*) from admin_mfa_recovery_code_sets"),
    ).toBe(0);

    // Fremder Origin scheitert vor der Fachlogik.
    const foreign = await codesRequest(app, nextCode, {
      cookie: mfaCookie,
      origin: FOREIGN_ORIGIN,
      remoteAddress: "192.0.2.72",
    });
    expect(foreign.statusCode).toBe(403);
    // Eigener Origin ist erlaubt.
    const ownOrigin = await codesRequest(app, wrongCode, {
      cookie: mfaCookie,
      origin: ORIGIN,
      remoteAddress: "192.0.2.72",
    });
    expect(ownOrigin.statusCode).toBe(401);

    // Erfolg: genau einmal Klartext, no-store.
    const issued = await codesRequest(app, nextCode, {
      cookie: mfaCookie,
      remoteAddress: "192.0.2.72",
    });
    expect(issued.statusCode, issued.body).toBe(200);
    expect(issued.headers["cache-control"]).toBe("no-store");
    const issuedBody = JSON.parse(issued.body) as { codes: string[]; created_at: string };
    expect(issuedBody.codes).toHaveLength(10);
    expect(await scalar("select count(*) from admin_mfa_recovery_code_sets")).toBe(1);
    expect(await scalar("select count(*) from admin_mfa_recovery_codes")).toBe(10);

    // Gespeichert sind ausschliesslich Hashes; jeder Klartext passt zu genau
    // einem Hash.
    const stored = await pool.query<{ code_hash: Buffer }>(
      "select code_hash from admin_mfa_recovery_codes where actor_id = $1",
      [LEGACY_ADMIN_ACTOR_ID],
    );
    for (const displayed of issuedBody.codes) {
      const normalized = normalizeRecoveryCode(displayed) as string;
      const expected = hashRecoveryCode(LEGACY_ADMIN_ACTOR_ID, normalized);
      expect(
        stored.rows.some((row) => Buffer.compare(row.code_hash, expected) === 0),
      ).toBe(true);
    }

    // Audit enthaelt weder Klartextcode noch TOTP-Code noch Secret.
    const auditRows = await pool.query<{ action: string; details: Record<string, unknown> }>(
      "select action, details from audit_events",
    );
    const auditText = JSON.stringify(auditRows.rows);
    for (const displayed of issuedBody.codes) {
      expect(auditText).not.toContain(bareCode(displayed));
    }
    expect(auditText).not.toContain(freshCode);
    expect(auditText).not.toContain(nextCode);
    expect(auditText).not.toContain(secret);
    expect(
      await scalar("select count(*) from audit_events where action = $1", [
        RECOVERY_CODE_SET_CREATED_ACTION,
      ]),
    ).toBe(1);

    // Logs enthalten weder Klartextcode noch TOTP-Code noch Sitzungscookie.
    const logText = logLines.join("");
    expect(logText.length).toBeGreaterThan(0);
    expect(logText).toContain(ADMIN_MFA_RECOVERY_CODES_URL);
    for (const displayed of issuedBody.codes) {
      expect(logText).not.toContain(bareCode(displayed));
    }
    expect(logText).not.toContain(freshCode);
    expect(logText).not.toContain(nextCode);
    expect(logText).not.toContain(secret);
    expect(logText).not.toContain(mfaCookie);

    // Replay desselben TOTP-Codes scheitert; Replay-Sperre steht auf dem
    // bereits verbrauchten Schritt.
    const replay = await codesRequest(app, nextCode, {
      cookie: mfaCookie,
      remoteAddress: "192.0.2.72",
    });
    expect(replay.statusCode).toBe(401);
    expect(await scalar("select count(*) from admin_mfa_recovery_code_sets")).toBe(1);
    expect(
      await numberValue(
        "select last_accepted_step from admin_mfa_totp_replay_state where actor_id = $1",
        "last_accepted_step",
        [LEGACY_ADMIN_ACTOR_ID],
      ),
    ).toBe(step + 1);

    // Ein frischer Schritt wird akzeptiert und ersetzt den Codesatz atomar.
    // Die Serveruhr rueckt dafuer einen Schritt weiter; step + 2 liegt sonst
    // ausserhalb des TOTP-Fensters.
    currentTimeMs = BASE_TIME + 2 * TOTP_STEP_MS;
    const replacedCode = referenceTotpStep(secret, step + 2);
    const replaced = await codesRequest(app, replacedCode, {
      cookie: mfaCookie,
      remoteAddress: "192.0.2.72",
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.headers["cache-control"]).toBe("no-store");
    expect(await scalar("select count(*) from admin_mfa_recovery_code_sets")).toBe(2);
    expect(
      await scalar(
        "select count(*) from admin_mfa_recovery_code_sets where invalidated_at is null",
      ),
    ).toBe(1);
    expect(
      await scalar("select count(*) from audit_events where action = $1", [
        RECOVERY_CODE_SET_REPLACED_ACTION,
      ]),
    ).toBe(1);

    // Keine lesende Code-API.
    const read = await app.inject({
      method: "GET",
      url: ADMIN_MFA_RECOVERY_CODES_URL,
      headers: adminHeaders({ cookie: mfaCookie }),
      remoteAddress: "192.0.2.72",
    });
    expect(read.statusCode).toBe(404);
  });
});
