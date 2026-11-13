import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_SET_CREATED_ACTION,
  RECOVERY_CODE_SET_REPLACED_ACTION,
  RECOVERY_CODE_USED_ACTION,
  RecoveryCodeSetExistsError,
  createRecoveryCodeService,
  generateRecoveryCodeSet,
  hashRecoveryCode,
  normalizeRecoveryCode,
  type RecoveryCodeService,
} from "./recoveryCodes.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

const BASE_TIME = Date.parse("2026-09-01T09:00:00.000Z");
const ACTOR_A = "SYN-CX065-ADMIN-A";
const ACTOR_B = "SYN-CX065-ADMIN-B";
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);

interface RandomBytesMock {
  mockImplementation: (impl: (size: number) => Buffer) => void;
  mock: { calls: Array<[number]> };
}

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let nowMs = BASE_TIME;
let service: RecoveryCodeService;

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
    throw new Error("CX-065 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

async function readMigration(name: string): Promise<string> {
  return readFile(join(MIGRATIONS_DIR, name), "utf8");
}

async function consumeInTransaction(
  code: string,
  actorId: string = ACTOR_A,
  target: RecoveryCodeService = service,
): Promise<{ consumed: boolean; codeSetId?: string }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await target.consume(actorId, code, client);
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

async function count(query: string, values: unknown[] = []): Promise<number> {
  const result = await pool.query<{ count: string }>(query, values);
  return Number(result.rows[0]?.count ?? "0");
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx065_" +
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

  service = createRecoveryCodeService({
    pool,
    now: () => new Date(nowMs),
  });
}, 60_000);

beforeEach(async () => {
  nowMs = BASE_TIME;
  const actual = await vi.importActual<typeof import("node:crypto")>(
    "node:crypto",
  );
  (randomBytes as unknown as RandomBytesMock).mockImplementation(
    actual.randomBytes,
  );
  if (pool !== undefined) {
    await pool.query(
      "truncate table admin_mfa_recovery_codes, admin_mfa_recovery_code_sets, audit_events restart identity cascade",
    );
  }
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

describe("CX-065 Erzeugung und Normalisierung", () => {
  it("erzeugt zehn unterschiedliche Codes mit je 128 Zufallsbits", async () => {
    const actual = await vi.importActual<typeof import("node:crypto")>(
      "node:crypto",
    );
    const randomBytesMock = randomBytes as unknown as RandomBytesMock;
    let next = 0;
    randomBytesMock.mockImplementation((size: number) => {
      expect(size).toBe(16);
      const bytes = Buffer.alloc(16, (next % 250) + 1);
      next += 1;
      return bytes;
    });

    try {
      const codes = generateRecoveryCodeSet();

      expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
      expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
      expect(randomBytesMock.mock.calls).toHaveLength(RECOVERY_CODE_COUNT);
      for (const call of randomBytesMock.mock.calls) {
        expect(call[0]).toBe(16);
      }

      for (const code of codes) {
        expect(code).toMatch(/^(?:[0-9A-F]{4}-){7}[0-9A-F]{4}$/);
        const normalized = normalizeRecoveryCode(code);
        expect(normalized).toMatch(/^[0-9A-F]{32}$/);
        expect(normalized).not.toBeNull();
        expect(Buffer.from(normalized as string, "hex")).toHaveLength(16);
        expect(hashRecoveryCode(ACTOR_A, normalized as string)).toHaveLength(32);
      }
    } finally {
      randomBytesMock.mockImplementation(actual.randomBytes);
    }
  });

  it("normalisiert nur Bindestriche und Grossschreibung", () => {
    const canonical =
      "0123-4567-89AB-CDEF-0123-4567-89AB-CDEF";
    const normalized = normalizeRecoveryCode(canonical);

    expect(normalized).toBe("0123456789ABCDEF0123456789ABCDEF");
    expect(normalizeRecoveryCode(canonical.toLowerCase())).toBe(normalized);
    expect(normalizeRecoveryCode(normalized as string)).toBe(normalized);

    expect(normalizeRecoveryCode(" " + canonical)).toBeNull();
    expect(normalizeRecoveryCode(canonical + " ")).toBeNull();
    expect(normalizeRecoveryCode(canonical + "\n")).toBeNull();
    expect(normalizeRecoveryCode(canonical.replace(/-/g, "").slice(0, 31))).toBeNull();
    expect(normalizeRecoveryCode(canonical.replace(/-/g, "") + "0")).toBeNull();
    expect(
      normalizeRecoveryCode(canonical.replace(/-/g, "").replace(/^./, "G")),
    ).toBeNull();
    expect(normalizeRecoveryCode(123 as unknown as string)).toBeNull();
    expect(normalizeRecoveryCode(null as unknown as string)).toBeNull();
  });

  it("trennt Hashes nach Domaene und Konto", () => {
    const normalized = "0123456789ABCDEF0123456789ABCDEF";
    const hashA = hashRecoveryCode(ACTOR_A, normalized);
    const hashB = hashRecoveryCode(ACTOR_B, normalized);

    expect(hashA).toHaveLength(32);
    expect(hashA.equals(hashB)).toBe(false);
    expect(hashA.equals(hashRecoveryCode(ACTOR_A, normalized))).toBe(true);
  });
});

describe("CX-065 Persistenz", () => {
  it("speichert nur Hashes und ungefaehrliche Verwaltungsdaten", async () => {
    const issued = await service.create(ACTOR_A);

    expect(issued.codes).toHaveLength(RECOVERY_CODE_COUNT);
    const rows = await pool.query<{
      set_id: string;
      actor_id: string;
      set_created_at: Date;
      invalidated_at: Date | null;
      code_id: string;
      code_set_id: string;
      code_actor_id: string;
      code_hash: Buffer;
      code_created_at: Date;
      used_at: Date | null;
    }>(
      [
        "select s.id::text as set_id, s.actor_id,",
        "       s.created_at as set_created_at, s.invalidated_at,",
        "       c.id::text as code_id, c.code_set_id::text as code_set_id,",
        "       c.actor_id as code_actor_id, c.code_hash,",
        "       c.created_at as code_created_at, c.used_at",
        "  from admin_mfa_recovery_code_sets s",
        "  join admin_mfa_recovery_codes c on c.code_set_id = s.id",
        " where s.actor_id = $1",
        " order by c.id",
      ].join("\n"),
      [ACTOR_A],
    );

    expect(rows.rowCount).toBe(RECOVERY_CODE_COUNT);
    const expectedHashes = new Set(
      issued.codes.map((code) => {
        const normalized = normalizeRecoveryCode(code);
        expect(normalized).not.toBeNull();
        return hashRecoveryCode(ACTOR_A, normalized as string).toString("hex");
      }),
    );

    for (const row of rows.rows) {
      expect(row.actor_id).toBe(ACTOR_A);
      expect(row.set_id).toBe(issued.codeSetId);
      expect(row.code_set_id).toBe(issued.codeSetId);
      expect(row.code_actor_id).toBe(ACTOR_A);
      expect(row.set_created_at).toEqual(issued.createdAt);
      expect(row.code_created_at).toEqual(issued.createdAt);
      expect(row.invalidated_at).toBeNull();
      expect(row.used_at).toBeNull();
      expect(row.code_hash).toHaveLength(32);
      expect(expectedHashes.has(row.code_hash.toString("hex"))).toBe(true);
    }

    const storedText = JSON.stringify(
      rows.rows.map((row) => ({
        ...row,
        code_hash: row.code_hash.toString("hex"),
      })),
    );
    for (const code of issued.codes) {
      const normalized = normalizeRecoveryCode(code) as string;
      expect(storedText).not.toContain(code);
      expect(storedText).not.toContain(normalized);
    }

    const audit = await pool.query<{
      action: string;
      actor_id: string | null;
      target_id: string | null;
      details: Record<string, unknown>;
    }>(
      "select action, actor_id, target_id, details from audit_events order by id",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].action).toBe(RECOVERY_CODE_SET_CREATED_ACTION);
    expect(audit.rows[0].actor_id).toBe(ACTOR_A);
    expect(audit.rows[0].target_id).toBe(issued.codeSetId);
    expect(audit.rows[0].details.code_count).toBe(RECOVERY_CODE_COUNT);
    const auditText = JSON.stringify(audit.rows);
    for (const code of issued.codes) {
      expect(auditText).not.toContain(code);
      expect(auditText).not.toContain(normalizeRecoveryCode(code) as string);
    }

    const duplicateError = await service
      .create(ACTOR_A)
      .then(() => null)
      .catch((error: unknown) => error as Error);
    expect(duplicateError).toBeInstanceOf(RecoveryCodeSetExistsError);
    expect(duplicateError?.message).not.toContain(issued.codes[0]);
    expect(
      await count(
        "select count(*)::text as count from admin_mfa_recovery_code_sets",
      ),
    ).toBe(1);
    expect(
      await count(
        "select count(*)::text as count from admin_mfa_recovery_codes",
      ),
    ).toBe(RECOVERY_CODE_COUNT);
  });
});

describe("CX-065 Einmalverbrauch", () => {
  it("laesst bei zwei parallelen Verbrauchsversuchen genau einen gewinnen", async () => {
    const issued = await service.create(ACTOR_A);
    const first = await pool.connect();
    const second = await pool.connect();
    let firstOpen = false;
    let secondOpen = false;

    try {
      await first.query("begin");
      firstOpen = true;
      await second.query("begin");
      secondOpen = true;

      const firstAttempt = service.consume(ACTOR_A, issued.codes[0], first);
      const secondAttempt = service.consume(ACTOR_A, issued.codes[0], second);

      const firstResult = await firstAttempt;
      await first.query("commit");
      firstOpen = false;
      const secondResult = await secondAttempt;
      await second.query("commit");
      secondOpen = false;

      expect([firstResult.consumed, secondResult.consumed].filter(Boolean)).toHaveLength(
        1,
      );
      expect(firstResult.codeSetId ?? secondResult.codeSetId).toBe(
        issued.codeSetId,
      );
    } finally {
      if (firstOpen) {
        await first.query("rollback").catch(() => undefined);
      }
      if (secondOpen) {
        await second.query("rollback").catch(() => undefined);
      }
      first.release();
      second.release();
    }

    expect(
      await count(
        "select count(*)::text as count from admin_mfa_recovery_codes where used_at is not null",
      ),
    ).toBe(1);
    expect(
      await count(
        "select count(*)::text as count from audit_events where action = $1",
        [RECOVERY_CODE_USED_ACTION],
      ),
    ).toBe(1);
    const auditText = JSON.stringify(
      (
        await pool.query<{ details: Record<string, unknown> }>(
          "select details from audit_events where action = $1",
          [RECOVERY_CODE_USED_ACTION],
        )
      ).rows,
    );
    for (const code of issued.codes) {
      expect(auditText).not.toContain(code);
      expect(auditText).not.toContain(normalizeRecoveryCode(code) as string);
    }
  });

  it("weist falsche, verbrauchte und fremde Codes zurueck", async () => {
    const issuedA = await service.create(ACTOR_A);
    const issuedB = await service.create(ACTOR_B);
    const allNormalized = new Set(
      [...issuedA.codes, ...issuedB.codes].map(
        (code) => normalizeRecoveryCode(code) as string,
      ),
    );
    const wrong = allNormalized.has("F".repeat(32))
      ? "E".repeat(32)
      : "F".repeat(32);
    expect(normalizeRecoveryCode(wrong)).toBe(wrong);
    expect(allNormalized.has(wrong)).toBe(false);

    expect((await consumeInTransaction(wrong, ACTOR_A)).consumed).toBe(false);

    const validA = issuedA.codes[0];
    expect((await consumeInTransaction(validA, ACTOR_B)).consumed).toBe(false);
    expect((await consumeInTransaction(validA, ACTOR_A)).consumed).toBe(true);
    expect((await consumeInTransaction(validA, ACTOR_A)).consumed).toBe(false);
    expect((await consumeInTransaction(validA + " ", ACTOR_A)).consumed).toBe(
      false,
    );

    expect((await consumeInTransaction(issuedA.codes[1], ACTOR_A)).consumed).toBe(
      true,
    );
    expect((await consumeInTransaction(issuedB.codes[0], ACTOR_B)).consumed).toBe(
      true,
    );
    expect(
      await count(
        "select count(*)::text as count from admin_mfa_recovery_codes where used_at is not null",
      ),
    ).toBe(3);
  });
});

describe("CX-065 Austausch und Auditfehler", () => {
  it("entwertet beim Austausch alle alten Codes atomar", async () => {
    const issuedA = await service.create(ACTOR_A);
    const issuedB = await service.create(ACTOR_B);
    const oldCodes = [...issuedA.codes];
    const replacement = await service.replace(ACTOR_A);

    expect(replacement.codeSetId).not.toBe(issuedA.codeSetId);
    expect(replacement.codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(replacement.codes).size).toBe(RECOVERY_CODE_COUNT);

    const sets = await pool.query<{
      id: string;
      actor_id: string;
      invalidated_at: Date | null;
    }>(
      [
        "select id::text as id, actor_id, invalidated_at",
        "  from admin_mfa_recovery_code_sets",
        " where actor_id = $1",
        " order by created_at, id",
      ].join("\n"),
      [ACTOR_A],
    );
    expect(sets.rowCount).toBe(2);
    const active = sets.rows.filter((row) => row.invalidated_at === null);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(replacement.codeSetId);
    const old = sets.rows.find((row) => row.id === issuedA.codeSetId);
    expect(old?.invalidated_at).not.toBeNull();

    expect(
      await count(
        "select count(*)::text as count from admin_mfa_recovery_codes where code_set_id = $1",
        [issuedA.codeSetId],
      ),
    ).toBe(RECOVERY_CODE_COUNT);
    for (const code of oldCodes) {
      expect((await consumeInTransaction(code, ACTOR_A)).consumed).toBe(false);
    }
    expect(
      (await consumeInTransaction(replacement.codes[0], ACTOR_A)).consumed,
    ).toBe(true);
    expect(
      (await consumeInTransaction(issuedB.codes[0], ACTOR_B)).consumed,
    ).toBe(true);

    const replacedAudit = await pool.query<{
      action: string;
      details: Record<string, unknown>;
    }>(
      "select action, details from audit_events where action = $1",
      [RECOVERY_CODE_SET_REPLACED_ACTION],
    );
    expect(replacedAudit.rows).toHaveLength(1);
    expect(replacedAudit.rows[0].details.replaced_code_set_id).toBe(
      issuedA.codeSetId,
    );
    expect(replacedAudit.rows[0].details.code_set_id).toBe(
      replacement.codeSetId,
    );

    const auditText = JSON.stringify(
      (
        await pool.query<{ details: Record<string, unknown> }>(
          "select details from audit_events",
        )
      ).rows,
    );
    for (const code of [...oldCodes, ...replacement.codes, ...issuedB.codes]) {
      expect(auditText).not.toContain(code);
      expect(auditText).not.toContain(normalizeRecoveryCode(code) as string);
    }
  });

  it("rollt Codeverbrauch und Austausch bei erzwungenem Auditfehler zurueck", async () => {
    const issued = await service.create(ACTOR_A);
    const failing = createRecoveryCodeService({
      pool,
      now: () => new Date(nowMs),
      auditWriter: async () => {
        throw new Error("SYN-CX065 erzwungener Auditfehler");
      },
    });

    const client = await pool.connect();
    try {
      await client.query("begin");
      await expect(
        failing.consume(ACTOR_A, issued.codes[0], client),
      ).rejects.toThrow("SYN-CX065 erzwungener Auditfehler");
      await client.query("rollback");
    } finally {
      client.release();
    }

    expect(
      await count(
        "select count(*)::text as count from admin_mfa_recovery_codes where used_at is not null",
      ),
    ).toBe(0);

    await expect(failing.replace(ACTOR_A)).rejects.toThrow(
      "SYN-CX065 erzwungener Auditfehler",
    );

    const sets = await pool.query<{
      id: string;
      invalidated_at: Date | null;
    }>(
      [
        "select id::text as id, invalidated_at",
        "  from admin_mfa_recovery_code_sets",
        " where actor_id = $1",
        " order by created_at",
      ].join("\n"),
      [ACTOR_A],
    );
    expect(sets.rowCount).toBe(1);
    expect(sets.rows[0].id).toBe(issued.codeSetId);
    expect(sets.rows[0].invalidated_at).toBeNull();
    expect(
      await count(
        "select count(*)::text as count from admin_mfa_recovery_codes where code_set_id = $1",
        [issued.codeSetId],
      ),
    ).toBe(RECOVERY_CODE_COUNT);
    expect((await consumeInTransaction(issued.codes[1], ACTOR_A)).consumed).toBe(
      true,
    );
    expect(
      await count("select count(*)::text as count from audit_events"),
    ).toBe(2);
  });
});

describe("CX-065 Migration", () => {
  it("legt die Tabellen additiv an und entfernt sie im Down wieder", async () => {
    const client: PoolClient = await pool.connect();
    const schema =
      "cx065_migration_" +
      process.pid +
      "_" +
      Date.now().toString(36).replace(/[^a-z0-9]/g, "");
    try {
      await client.query("create schema " + quoteIdentifier(schema));
      await client.query("set search_path to " + quoteIdentifier(schema));
      await client.query(
        await readMigration("0008_cx_065_admin_mfa_recovery_codes.up.sql"),
      );
      const present = await client.query<{ name: string | null }>(
        "select to_regclass('admin_mfa_recovery_code_sets') as name",
      );
      expect(present.rows[0]?.name).not.toBeNull();
      const codesPresent = await client.query<{ name: string | null }>(
        "select to_regclass('admin_mfa_recovery_codes') as name",
      );
      expect(codesPresent.rows[0]?.name).not.toBeNull();

      await client.query(
        await readMigration("0008_cx_065_admin_mfa_recovery_codes.down.sql"),
      );
      const absent = await client.query<{ name: string | null }>(
        "select to_regclass('admin_mfa_recovery_code_sets') as name",
      );
      expect(absent.rows[0]?.name).toBeNull();

      await client.query(
        await readMigration("0008_cx_065_admin_mfa_recovery_codes.up.sql"),
      );
      const again = await client.query<{ name: string | null }>(
        "select to_regclass('admin_mfa_recovery_codes') as name",
      );
      expect(again.rows[0]?.name).not.toBeNull();
    } finally {
      await client.query("set search_path to public");
      await client.query(
        "drop schema if exists " + quoteIdentifier(schema) + " cascade",
      );
      client.release();
    }
  });
});
