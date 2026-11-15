/**
 * CX-108 / R-605: Abschluss der TOTP-Einrichtung.
 *
 * Echte Fastify-Instanzen, echte PostgreSQL-Datenbank, echte Admin-Sitzung,
 * echter CX-106-Einrichtungsspeicher, echter CX-017-TOTP-Pruefkern und echte
 * CX-065-Wiederherstellungscodes. Keine Mocks fuer Persistenz oder Audit.
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
import { createLegacyAdminPrincipalResolver } from "../../http/principal.js";
import { RateLimiter } from "../../http/rateLimit.js";
import { ADMIN_SESSION_COOKIE } from "./middleware.js";
import { PendingTotpEnrollmentStore } from "./pendingTotpEnrollment.js";
import {
  RECOVERY_CODE_SET_CREATED_ACTION,
  createRecoveryCodeService,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from "./recoveryCodes.js";
import { ensureAdminMfaRecoverySchema } from "./recoveryRoutes.js";
import {
  createAdminLoginRateLimiter,
  registerAdminAuthRoutes,
} from "./routes.js";
import {
  AdminAuthService,
  LEGACY_ADMIN_ACTOR_ID,
} from "./service.js";
import { generateTotpSecret } from "./totp.js";
import {
  ADMIN_MFA_TOTP_CONFIRM_ACTION,
  ADMIN_MFA_TOTP_CONFIRM_URL,
  ensureAdminTotpConfirmSchema,
  registerAdminTotpSetupConfirmRoutes,
} from "./totpSetupConfirm.js";

const BASE_TIME = Date.parse("2026-11-15T09:00:00.000Z");
const STEP_MS = 30_000;
const ADMIN_PASSWORD = "SYN-CX108-Admin-Passwort";
const HOST = "127.0.0.1:8080";
const JSON_HEADERS = { "content-type": "application/json" };
const TOTP_KEY = randomBytes(32);
const FOREIGN_ACTOR = "fremder-admin";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);

const REFERENCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function referenceDecodeBase32(secret: string): Buffer {
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of secret) {
    accumulator =
      ((accumulator << 5) | REFERENCE_ALPHABET.indexOf(character)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function referenceTotp(secretBase32: string, step: number): string {
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

function codeFor(secret: string, atMs: number): string {
  return referenceTotp(secret, Math.floor(atMs / STEP_MS));
}

function flipCode(code: string): string {
  return (code[0] === "0" ? "1" : "0") + code.slice(1);
}

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
const openApps: FastifyInstance[] = [];

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
    throw new Error("CX-108 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function clock(): Date {
  return new Date(BASE_TIME);
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx108_" +
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
    registrationCodePepper: "SYN-CX108-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 120_000);

beforeEach(async () => {
  await pool.query("drop trigger if exists cx108_fail_confirm_audit on audit_events");
  await pool.query("drop function if exists cx108_fail_confirm_audit() cascade");
  await pool.query(
    [
      "truncate table admin_mfa_recovery_codes, admin_mfa_recovery_code_sets,",
      "  admin_mfa_recovery_challenges, admin_mfa_totp_replay_state,",
      "  admin_mfa_totp_confirm_attempts, admin_mfa_pending_totp_enrollments,",
      "  admin_sessions, audit_events",
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
  const app = Fastify({ logger: false, disableRequestLogging: true });
  await app.register(cookie);
  const adminAuth = new AdminAuthService({ pool, config, now: clock });
  installAccessControl(app, {
    resolvePrincipal: createLegacyAdminPrincipalResolver(adminAuth),
  });
  registerErrorHandler(app);
  const limiter = createAdminLoginRateLimiter(config, () => clock().getTime());
  registerAdminAuthRoutes(app, { service: adminAuth, loginLimiter: limiter, config });
  registerAdminTotpSetupConfirmRoutes(app, {
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

function sessionCookieOf(response: {
  headers: Record<string, unknown>;
}): string {
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw)
    ? (raw[0] as string)
    : (raw as string | undefined);
  if (first === undefined) {
    throw new Error("Set-Cookie fehlt");
  }
  const pair = first.split(";")[0] as string;
  const prefix = ADMIN_SESSION_COOKIE + "=";
  if (!pair.startsWith(prefix)) {
    throw new Error("Unerwartetes Sitzungscookie");
  }
  return pair.slice(prefix.length);
}

async function login(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, ...JSON_HEADERS },
    payload: { password: ADMIN_PASSWORD },
    remoteAddress: "192.0.2.108",
  });
  expect(response.statusCode).toBe(204);
  return sessionCookieOf(response);
}

interface PendingFixture {
  enrollmentId: string;
  secret: string;
}

async function createPending(
  actorId: string,
  options: { expiresAt?: Date; secret?: string } = {},
): Promise<PendingFixture> {
  const secret = options.secret ?? generateTotpSecret();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const store = new PendingTotpEnrollmentStore({
      client,
      key: TOTP_KEY,
      now: clock,
    });
    const pending = await store.replace(actorId, secret);
    if (options.expiresAt !== undefined) {
      await client.query(
        [
          "update admin_mfa_pending_totp_enrollments",
          "   set expires_at = $3",
          " where actor_id = $1",
          "   and enrollment_id = $2::uuid",
        ].join("\n"),
        [actorId, pending.enrollmentId, options.expiresAt],
      );
    }
    await client.query("commit");
    return { enrollmentId: pending.enrollmentId, secret };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function confirm(
  app: FastifyInstance,
  cookieValue: string,
  payload: Record<string, unknown>,
  remoteAddress = "192.0.2.109",
) {
  return app.inject({
    method: "POST",
    url: ADMIN_MFA_TOTP_CONFIRM_URL,
    headers: {
      host: HOST,
      ...JSON_HEADERS,
      cookie: ADMIN_SESSION_COOKIE + "=" + cookieValue,
    },
    payload,
    remoteAddress,
  });
}

interface ActiveRow {
  last_accepted_step: string;
  activated_at: Date | null;
  enrollment_id: string | null;
  nonce: Buffer | null;
  ciphertext: Buffer | null;
  tag: Buffer | null;
}

async function activeRow(): Promise<ActiveRow | undefined> {
  const result = await pool.query<ActiveRow>(
    [
      "select last_accepted_step, activated_at, enrollment_id,",
      "       nonce, ciphertext, tag",
      "  from admin_mfa_totp_replay_state",
      " where actor_id = $1",
    ].join("\n"),
    [LEGACY_ADMIN_ACTOR_ID],
  );
  return result.rows[0];
}

async function recoveryState(): Promise<{
  sets: number;
  codes: number;
  activeSets: number;
}> {
  const sets = await pool.query<{ count: string; active: string }>(
    [
      "select count(*)::text as count,",
      "       count(*) filter (where invalidated_at is null)::text as active",
      "  from admin_mfa_recovery_code_sets",
    ].join("\n"),
  );
  const codes = await pool.query<{ count: string }>(
    "select count(*)::text as count from admin_mfa_recovery_codes",
  );
  return {
    sets: Number(sets.rows[0]?.count ?? "0"),
    codes: Number(codes.rows[0]?.count ?? "0"),
    activeSets: Number(sets.rows[0]?.active ?? "0"),
  };
}

describe("CX-108 TOTP-Einrichtung bestaetigen", () => {
  it("aktiviert den vorhandenen MFA-Zustand, verbraucht die Einrichtung und liefert einmalig nutzbare Wiederherstellungscodes", async () => {
    const { app } = await buildApp();
    const session = await login(app);
    const pending = await createPending(LEGACY_ADMIN_ACTOR_ID);
    const code = codeFor(pending.secret, BASE_TIME);

    const response = await confirm(app, session, {
      enrollment_id: pending.enrollmentId,
      code,
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json() as { codes: string[]; activated_at: string };
    expect(body.codes).toHaveLength(10);
    expect(new Set(body.codes).size).toBe(10);
    expect(body.activated_at).toBe(clock().toISOString());

    const active = await activeRow();
    expect(active).toBeDefined();
    expect(active?.activated_at).not.toBeNull();
    expect(active?.enrollment_id).toBe(pending.enrollmentId);
    expect(active?.last_accepted_step).toBe(
      String(Math.floor(BASE_TIME / STEP_MS)),
    );
    expect(active?.nonce).toHaveLength(12);
    expect(active?.tag).toHaveLength(16);
    expect(active?.ciphertext?.includes(Buffer.from(pending.secret))).toBe(false);

    const pendingCount = await pool.query<{ count: string }>(
      "select count(*)::text as count from admin_mfa_pending_totp_enrollments",
    );
    expect(Number(pendingCount.rows[0]?.count)).toBe(0);

    const recovery = await recoveryState();
    expect(recovery.sets).toBe(1);
    expect(recovery.activeSets).toBe(1);
    expect(recovery.codes).toBe(10);

    const storedHashes = await pool.query<{ code_hash: Buffer }>(
      "select code_hash from admin_mfa_recovery_codes",
    );
    const stored = new Set(
      storedHashes.rows.map((row) => row.code_hash.toString("hex")),
    );
    for (const plain of body.codes) {
      const normalized = normalizeRecoveryCode(plain);
      expect(normalized).not.toBeNull();
      expect(
        stored.has(
          hashRecoveryCode(LEGACY_ADMIN_ACTOR_ID, normalized as string).toString(
            "hex",
          ),
        ),
      ).toBe(true);
    }

    const service = createRecoveryCodeService({ pool, now: clock });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const first = await service.consume(
        LEGACY_ADMIN_ACTOR_ID,
        body.codes[0] as string,
        client,
      );
      const second = await service.consume(
        LEGACY_ADMIN_ACTOR_ID,
        body.codes[0] as string,
        client,
      );
      await client.query("commit");
      expect(first.consumed).toBe(true);
      expect(second.consumed).toBe(false);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    const repeated = await confirm(app, session, {
      enrollment_id: pending.enrollmentId,
      code,
    });
    expect(repeated.statusCode).toBe(409);
    expect(JSON.stringify(repeated.body)).not.toContain(body.codes[0]);
  });

  it("aktiviert bei falschem, abgelaufenem oder fremdem Nachweis nichts und sperrt nach fuenf Fehlversuchen", async () => {
    const { app, limiter } = await buildApp();
    const session = await login(app);
    const pending = await createPending(LEGACY_ADMIN_ACTOR_ID);
    const correct = codeFor(pending.secret, BASE_TIME);

    const wrong = await confirm(app, session, {
      enrollment_id: pending.enrollmentId,
      code: flipCode(correct),
    });
    expect(wrong.statusCode).toBe(401);
    const afterWrong = await pool.query<{
      failed_attempts: number;
      locked_at: Date | null;
    }>(
      [
        "select failed_attempts, locked_at",
        "  from admin_mfa_totp_confirm_attempts",
        " where enrollment_id = $1::uuid",
        "   and actor_id = $2",
      ].join("\n"),
      [pending.enrollmentId, LEGACY_ADMIN_ACTOR_ID],
    );
    expect(afterWrong.rows[0]?.failed_attempts).toBe(1);
    expect(await activeRow()).toBeUndefined();
    expect(await recoveryState()).toEqual({ sets: 0, codes: 0, activeSets: 0 });

    const expired = await createPending(LEGACY_ADMIN_ACTOR_ID, {
      expiresAt: new Date(BASE_TIME - STEP_MS),
    });
    const expiredResponse = await confirm(app, session, {
      enrollment_id: expired.enrollmentId,
      code: codeFor(expired.secret, BASE_TIME),
    });
    expect(expiredResponse.statusCode).toBe(401);
    expect(await activeRow()).toBeUndefined();

    const foreign = await createPending(FOREIGN_ACTOR);
    const foreignResponse = await confirm(app, session, {
      enrollment_id: foreign.enrollmentId,
      code: codeFor(foreign.secret, BASE_TIME),
    });
    expect(foreignResponse.statusCode).toBe(401);
    expect(await activeRow()).toBeUndefined();

    // Die vorhandene Einrichtung wurde durch die fremde/abgelaufene Probe
    // nicht ersetzt; fuenf falsche Codes sperren sie dauerhaft.
    const first = await createPending(LEGACY_ADMIN_ACTOR_ID);
    const firstCode = codeFor(first.secret, BASE_TIME);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      limiter.reset();
      const response = await confirm(app, session, {
        enrollment_id: first.enrollmentId,
        code: flipCode(firstCode),
      });
      expect(response.statusCode).toBe(attempt === 5 ? 409 : 401);
    }

    const locked = await pool.query<{
      failed_attempts: number;
      locked_at: Date | null;
    }>(
      [
        "select failed_attempts, locked_at",
        "  from admin_mfa_totp_confirm_attempts",
        " where enrollment_id = $1::uuid",
        "   and actor_id = $2",
      ].join("\n"),
      [first.enrollmentId, LEGACY_ADMIN_ACTOR_ID],
    );
    expect(locked.rows[0]?.failed_attempts).toBe(5);
    expect(locked.rows[0]?.locked_at).not.toBeNull();
    expect(await activeRow()).toBeUndefined();
    expect(await recoveryState()).toEqual({ sets: 0, codes: 0, activeSets: 0 });

    limiter.reset();
    const afterLock = await confirm(app, session, {
      enrollment_id: first.enrollmentId,
      code: firstCode,
    });
    expect(afterLock.statusCode).toBe(409);
    expect(await activeRow()).toBeUndefined();
  });

  it("erzeugt bei parallelen Bestaetigungen nur eine Aktivierung und rollt bei provoziertem Auditfehler alles zurueck", async () => {
    const { app } = await buildApp();
    const session = await login(app);
    const pending = await createPending(LEGACY_ADMIN_ACTOR_ID);
    const code = codeFor(pending.secret, BASE_TIME);

    await pool.query(
      [
        "create function cx108_fail_confirm_audit() returns trigger",
        "language plpgsql as $fn$",
        "begin",
        "  if new.action = '" + ADMIN_MFA_TOTP_CONFIRM_ACTION + "' then",
        "    raise exception 'CX-108 provozierter Auditfehler';",
        "  end if;",
        "  return new;",
        "end",
        "$fn$",
      ].join("\n"),
    );
    await pool.query(
      [
        "create trigger cx108_fail_confirm_audit",
        "before insert on audit_events",
        "for each row execute function cx108_fail_confirm_audit()",
      ].join("\n"),
    );

    const failed = await confirm(app, session, {
      enrollment_id: pending.enrollmentId,
      code,
    });
    expect(failed.statusCode).toBe(500);
    expect(await activeRow()).toBeUndefined();
    expect(await recoveryState()).toEqual({ sets: 0, codes: 0, activeSets: 0 });
    const stillPending = await pool.query<{ count: string }>(
      "select count(*)::text as count from admin_mfa_pending_totp_enrollments",
    );
    expect(Number(stillPending.rows[0]?.count)).toBe(1);
    const confirmAudits = await pool.query<{ count: string }>(
      "select count(*)::text as count from audit_events where action = $1",
      [ADMIN_MFA_TOTP_CONFIRM_ACTION],
    );
    expect(Number(confirmAudits.rows[0]?.count)).toBe(0);
    const codeSetAudits = await pool.query<{ count: string }>(
      "select count(*)::text as count from audit_events where action = $1",
      [RECOVERY_CODE_SET_CREATED_ACTION],
    );
    expect(Number(codeSetAudits.rows[0]?.count)).toBe(0);

    await pool.query("drop trigger cx108_fail_confirm_audit on audit_events");
    await pool.query("drop function cx108_fail_confirm_audit() cascade");

    const responses = await Promise.all([
      confirm(app, session, {
        enrollment_id: pending.enrollmentId,
        code,
      }),
      confirm(app, session, {
        enrollment_id: pending.enrollmentId,
        code,
      }),
    ]);
    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([201, 409]);

    const active = await activeRow();
    expect(active?.activated_at).not.toBeNull();
    expect(await recoveryState()).toEqual({
      sets: 1,
      codes: 10,
      activeSets: 1,
    });
    const pendingCount = await pool.query<{ count: string }>(
      "select count(*)::text as count from admin_mfa_pending_totp_enrollments",
    );
    expect(Number(pendingCount.rows[0]?.count)).toBe(0);
    const confirmAuditsAfter = await pool.query<{ count: string }>(
      "select count(*)::text as count from audit_events where action = $1",
      [ADMIN_MFA_TOTP_CONFIRM_ACTION],
    );
    expect(Number(confirmAuditsAfter.rows[0]?.count)).toBe(1);
  });
});

