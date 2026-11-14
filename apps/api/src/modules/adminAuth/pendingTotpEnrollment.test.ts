import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { matchTotpStep } from "./totp.js";
import {
  PENDING_TOTP_ENROLLMENT_TTL_MS,
  PendingTotpCryptoError,
  PendingTotpEnrollmentStore,
  PendingTotpKeyError,
  type PendingTotpSqlClient,
  type PendingTotpStoreOptions,
} from "./pendingTotpEnrollment.js";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);

const ACTOR_A = "SYN-CX106-ADMIN-A";
const ACTOR_B = "SYN-CX106-ADMIN-B";
const BASE_TIME = Date.parse("2026-10-01T09:00:00.000Z");
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const KEY_A = Buffer.alloc(32, 0x41);
const KEY_B = Buffer.alloc(32, 0x42);

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let nowMs = BASE_TIME;

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
    throw new Error("CX-106 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

async function readMigration(name: string): Promise<string> {
  return readFile(join(MIGRATIONS_DIR, name), "utf8");
}

function storeFor(
  client: PendingTotpSqlClient,
  key: Buffer = KEY_A,
): PendingTotpEnrollmentStore {
  return new PendingTotpEnrollmentStore({
    client,
    key,
    now: () => new Date(nowMs),
  });
}

async function inTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
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

async function replaceInOwnTransaction(secret: string) {
  return inTransaction((client) =>
    storeFor(client).replace(ACTOR_A, secret),
  );
}

async function read(actorId: string, enrollmentId: string) {
  return inTransaction((client) => storeFor(client).read(actorId, enrollmentId));
}

async function count(query: string, values: unknown[] = []): Promise<number> {
  const result = await pool.query<{ count: string }>(query, values);
  return Number(result.rows[0]?.count ?? "0");
}

async function insertRecoveryFixture(): Promise<{
  setId: string;
  codeHashHex: string;
}> {
  const setId = randomUUID();
  const codeHash = randomBytes(32);
  const createdAt = new Date(BASE_TIME);
  await pool.query(
    "insert into admin_mfa_recovery_code_sets (id, actor_id, created_at) values ($1, $2, $3)",
    [setId, "SYN-CX106-EXISTING", createdAt],
  );
  await pool.query(
    [
      "insert into admin_mfa_recovery_codes",
      "  (id, code_set_id, actor_id, code_hash, created_at)",
      "values ($1, $2, $3, $4, $5)",
    ].join("\n"),
    [randomUUID(), setId, "SYN-CX106-EXISTING", codeHash, createdAt],
  );
  return { setId, codeHashHex: codeHash.toString("hex") };
}

async function cipherFields(): Promise<{
  ciphertext: Buffer;
  tag: Buffer;
}> {
  const result = await pool.query<{ ciphertext: Buffer; tag: Buffer }>(
    [
      "select ciphertext, tag",
      "  from admin_mfa_pending_totp_enrollments",
      " where actor_id = $1",
    ].join("\n"),
    [ACTOR_A],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Testfixture fehlt");
  }
  return row;
}

async function expectCryptoFailure(
  actorId: string,
  enrollmentId: string,
  key: Buffer = KEY_A,
): Promise<void> {
  let caught: unknown;
  try {
    await inTransaction((client) =>
      storeFor(client, key).read(actorId, enrollmentId),
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PendingTotpCryptoError);
  const message = (caught as Error).message;
  expect(message).toBe(
    "Ausstehende TOTP-Einrichtung konnte nicht verarbeitet werden",
  );
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx106_" +
    process.pid +
    "_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 8)
  )
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query(
    "create database " + quoteIdentifier(databaseName),
  );

  pool = new Pool({ ...base, database: databaseName });
  await pool.query(await readMigration("0001_gt_ads_001.up.sql"));
  await pool.query(
    await readMigration("0008_cx_065_admin_mfa_recovery_codes.up.sql"),
  );
  await pool.query(
    await readMigration("0013_cx_106_pending_totp_enrollment.up.sql"),
  );
}, 60_000);

beforeEach(async () => {
  nowMs = BASE_TIME;
  await pool.query(
    "truncate table admin_mfa_pending_totp_enrollments",
  );
  await pool.query(
    "truncate table admin_mfa_recovery_codes, admin_mfa_recovery_code_sets restart identity cascade",
  );
});

afterAll(async () => {
  if (pool !== undefined) {
    await pool.end();
  }
  if (maintenancePool !== undefined) {
    await maintenancePool.query(
      "drop database if exists " + quoteIdentifier(databaseName),
    );
    await maintenancePool.end();
  }
}, 30_000);

describe("CX-106 Migration und Speicherung", () => {
  it("speichert verschluesselt, liest ueber eine neue Instanz und entfernt beim Down nur die neue Struktur", async () => {
    const saved = await inTransaction((client) =>
      storeFor(client).replace(ACTOR_A, SECRET),
    );
    expect(saved.expiresAt.getTime()).toBe(
      BASE_TIME + PENDING_TOTP_ENROLLMENT_TTL_MS,
    );

    const loaded = await read(ACTOR_A, saved.enrollmentId);
    expect(loaded).not.toBeNull();
    expect(loaded?.enrollmentId).toBe(saved.enrollmentId);
    expect(loaded?.secret).toBe(SECRET);
    expect(loaded?.expiresAt.getTime()).toBe(saved.expiresAt.getTime());

    const raw = await pool.query<{
      enrollment_id: string;
      nonce: Buffer;
      ciphertext: Buffer;
      tag: Buffer;
    }>(
      [
        "select enrollment_id::text as enrollment_id, nonce, ciphertext, tag",
        "  from admin_mfa_pending_totp_enrollments",
      ].join("\n"),
    );
    expect(raw.rowCount).toBe(1);
    const row = raw.rows[0];
    for (const field of ["nonce", "ciphertext", "tag"] as const) {
      const value = row[field];
      expect(value.toString("utf8")).not.toContain(SECRET);
      expect(value.includes(Buffer.from(SECRET, "utf8"))).toBe(false);
      expect(value.toString("base64")).not.toContain(
        Buffer.from(SECRET, "utf8").toString("base64"),
      );
    }

    const fixture = await insertRecoveryFixture();
    await pool.query(
      await readMigration("0013_cx_106_pending_totp_enrollment.down.sql"),
    );

    const pending = await pool.query<{ table: string | null }>(
      "select to_regclass('public.admin_mfa_pending_totp_enrollments')::text as table",
    );
    expect(pending.rows[0]?.table).toBeNull();
    expect(
      await count("select count(*) from admin_mfa_recovery_code_sets"),
    ).toBe(1);
    expect(
      await count("select count(*) from admin_mfa_recovery_codes"),
    ).toBe(1);
    const codeHash = await pool.query<{ code_hash: Buffer }>(
      "select code_hash from admin_mfa_recovery_codes where code_set_id = $1",
      [fixture.setId],
    );
    expect(codeHash.rows[0]?.code_hash.toString("hex")).toBe(
      fixture.codeHashHex,
    );

    await pool.query(
      await readMigration("0013_cx_106_pending_totp_enrollment.up.sql"),
    );
    const restored = await pool.query<{ table: string | null }>(
      "select to_regclass('public.admin_mfa_pending_totp_enrollments')::text as table",
    );
    expect(restored.rows[0]?.table).not.toBeNull();
  });
});

describe("CX-106 atomare Ersetzung", () => {
  it("hinterlaesst bei zwei konkurrierenden Ersetzungen genau eine vollstaendige Einrichtung", async () => {
    const secretOne = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    const secretTwo = "KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU";

    const [first, second] = await Promise.all([
      replaceInOwnTransaction(secretOne),
      replaceInOwnTransaction(secretTwo),
    ]);
    expect(first.enrollmentId).not.toBe(second.enrollmentId);

    expect(
      await count(
        "select count(*) from admin_mfa_pending_totp_enrollments",
      ),
    ).toBe(1);
    expect(
      await count(
        [
          "select count(*) from admin_mfa_pending_totp_enrollments",
          " where actor_id = $1",
        ].join("\n"),
        [ACTOR_A],
      ),
    ).toBe(1);

    const firstRead = await read(ACTOR_A, first.enrollmentId);
    const secondRead = await read(ACTOR_A, second.enrollmentId);
    const readable = [firstRead, secondRead].filter(
      (value) => value !== null,
    );
    expect(readable).toHaveLength(1);
    expect([secretOne, secretTwo]).toContain(readable[0]?.secret);

    const replacedId =
      firstRead === null ? first.enrollmentId : second.enrollmentId;
    expect(await read(ACTOR_A, replacedId)).toBeNull();

    const current = readable[0];
    expect(current).not.toBeNull();

    let rolledBackId = "";
    const client = await pool.connect();
    try {
      await client.query("begin");
      const rolledBack = await storeFor(client).replace(
        ACTOR_A,
        "ROLLED-BACK-SYNTHETIC-SECRET",
      );
      rolledBackId = rolledBack.enrollmentId;
      await client.query("rollback");
    } finally {
      client.release();
    }

    const afterRollback = await read(ACTOR_A, current?.enrollmentId ?? "");
    expect(afterRollback?.secret).toBe(current?.secret);
    expect(afterRollback?.enrollmentId).toBe(current?.enrollmentId);
    expect(await read(ACTOR_A, rolledBackId)).toBeNull();
    expect(
      await count(
        "select count(*) from admin_mfa_pending_totp_enrollments",
      ),
    ).toBe(1);
  });
});

describe("CX-106 befristetes und identitaetsgebundenes Lesen", () => {
  it("liest vor Ablauf, verweigert exakt nach zehn Minuten und bei fremder Identitaet", async () => {
    const saved = await inTransaction((client) =>
      storeFor(client).replace(ACTOR_A, SECRET),
    );

    nowMs = BASE_TIME + PENDING_TOTP_ENROLLMENT_TTL_MS - 1;
    const beforeExpiry = await read(ACTOR_A, saved.enrollmentId);
    expect(beforeExpiry?.secret).toBe(SECRET);

    nowMs = BASE_TIME + PENDING_TOTP_ENROLLMENT_TTL_MS;
    expect(await read(ACTOR_A, saved.enrollmentId)).toBeNull();

    nowMs = BASE_TIME;
    expect(await read(ACTOR_B, saved.enrollmentId)).toBeNull();
    expect(await read(ACTOR_A, randomUUID())).toBeNull();

    const fixture = await insertRecoveryFixture();
    expect(
      await count("select count(*) from admin_mfa_recovery_code_sets"),
    ).toBe(1);
    expect(
      await count("select count(*) from admin_mfa_recovery_codes"),
    ).toBe(1);
    const codeHash = await pool.query<{ code_hash: Buffer }>(
      "select code_hash from admin_mfa_recovery_codes where code_set_id = $1",
      [fixture.setId],
    );
    expect(codeHash.rows[0]?.code_hash.toString("hex")).toBe(
      fixture.codeHashHex,
    );

    expect(matchTotpStep(SECRET, "287082", 59_000, null)).toBe(1);
  });
});

describe("CX-106 Schluessel und Manipulation", () => {
  it("verhindert Speicherung ohne gueltigen Schluessel und bereinigt Kryptofehler", async () => {
    const missingKey = {} as PendingTotpStoreOptions;
    expect(
      () =>
        new PendingTotpEnrollmentStore({
          ...missingKey,
          client: pool,
        }),
    ).toThrow(PendingTotpKeyError);
    for (const length of [0, 31, 33]) {
      expect(
        () =>
          new PendingTotpEnrollmentStore({
            client: pool,
            key: Buffer.alloc(length),
          }),
      ).toThrow(PendingTotpKeyError);
    }
    expect(
      await count(
        "select count(*) from admin_mfa_pending_totp_enrollments",
      ),
    ).toBe(0);

    const saved = await inTransaction((client) =>
      storeFor(client).replace(ACTOR_A, SECRET),
    );
    await expectCryptoFailure(ACTOR_A, saved.enrollmentId, KEY_B);

    await pool.query(
      [
        "update admin_mfa_pending_totp_enrollments",
        "   set ciphertext = set_byte(",
        "         ciphertext, 0, (get_byte(ciphertext, 0) + 1) % 256)",
        " where actor_id = $1",
      ].join("\n"),
      [ACTOR_A],
    );
    await expectCryptoFailure(ACTOR_A, saved.enrollmentId);

    const fresh = await inTransaction((client) =>
      storeFor(client).replace(ACTOR_A, SECRET),
    );
    await pool.query(
      [
        "update admin_mfa_pending_totp_enrollments",
        "   set tag = set_byte(tag, 0, (get_byte(tag, 0) + 1) % 256)",
        " where actor_id = $1",
      ].join("\n"),
      [ACTOR_A],
    );
    await expectCryptoFailure(ACTOR_A, fresh.enrollmentId);

    const freshAgain = await inTransaction((client) =>
      storeFor(client).replace(ACTOR_A, SECRET),
    );
    const tamperedId = randomUUID();
    await pool.query(
      [
        "update admin_mfa_pending_totp_enrollments",
        "   set enrollment_id = $2",
        " where actor_id = $1",
      ].join("\n"),
      [ACTOR_A, tamperedId],
    );
    await expectCryptoFailure(ACTOR_A, tamperedId);
    expect(await read(ACTOR_A, freshAgain.enrollmentId)).toBeNull();

    const fields = await cipherFields();
    let caught: unknown;
    try {
      await inTransaction((client) =>
        storeFor(client, KEY_B).read(ACTOR_A, tamperedId),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PendingTotpCryptoError);
    const message = (caught as Error).message;
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain(KEY_A.toString("hex"));
    expect(message).not.toContain(KEY_A.toString("base64"));
    expect(message).not.toContain(KEY_B.toString("hex"));
    expect(message).not.toContain(fields.ciphertext.toString("hex"));
    expect(message).not.toContain(fields.tag.toString("hex"));
  });
});
