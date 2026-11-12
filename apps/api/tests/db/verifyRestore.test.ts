import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDump,
  type DumpArtifact,
  type LocalDumpConnection,
} from "../../src/modules/backup/createDump.js";
import {
  verifyRestore,
  type VerifyRestoreOptions,
} from "../../src/modules/backup/verifyRestore.js";

const scratchDirectories: string[] = [];
const createdTargets = new Set<string>();

let maintenancePool: Pool;
let syntheticPool: Pool;
let syntheticDatabase = "";
let connection: LocalDumpConnection;
let artifact: DumpArtifact;

function run(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new Error(
              command + " " + args.join(" ") + ": " + error.message + "\n" + stderr,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

async function makeScratchDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cx023-" + label + "-"));
  scratchDirectories.push(directory);
  return directory;
}

function baseConnection(): LocalDumpConnection {
  const host = process.env.PGHOST;
  const user = process.env.PGUSER;
  const database = process.env.PGDATABASE;
  const port = Number(process.env.PGPORT ?? "5432");

  if (host === undefined || user === undefined || database === undefined) {
    throw new Error(
      "CX-023 benoetigt das PostgreSQL-Testsetup: with-postgres <befehl>",
    );
  }

  return { host, port, database, user };
}

async function writeFakePgRestore(
  directory: string,
  name: string,
  body: string,
): Promise<string> {
  const path = join(directory, "fake-" + name + ".cjs");
  await writeFile(path, "#!/usr/bin/env node\n" + body, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForPath(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pathExists(path)) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error("Markerdatei wurde nicht erstellt: " + path);
}

async function listRestoreDatabases(): Promise<string[]> {
  const result = await maintenancePool.query<{ datname: string }>(
    "select datname from pg_database where datname like 'gtads_restore_%' order by datname",
  );
  return result.rows.map((row) => row.datname);
}

async function databaseExists(name: string): Promise<boolean> {
  const result = await maintenancePool.query<{ exists: boolean }>(
    "select exists(select 1 from pg_database where datname = $1) as exists",
    [name],
  );
  return result.rows[0]?.exists === true;
}

async function dropOwnDatabase(name: string): Promise<void> {
  await maintenancePool.query(
    "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
    [name],
  );
  await maintenancePool.query("drop database if exists " + quoteIdentifier(name));
}

async function readSourceState(): Promise<{
  orders: unknown[];
  items: unknown[];
}> {
  const orders = await syntheticPool.query(
    "select id, code, amount::text as amount from cx023_orders order by id",
  );
  const items = await syntheticPool.query(
    "select id, order_id, label from cx023_items order by id",
  );
  return { orders: orders.rows, items: items.rows };
}

beforeAll(async () => {
  const base = baseConnection();

  // Der erste Test arbeitet mit echten PostgreSQL-17-Werkzeugen.
  const dumpVersion = await run("pg_dump", ["--version"]);
  const restoreVersion = await run("pg_restore", ["--version"]);
  expect(dumpVersion.stdout).toMatch(/PostgreSQL\) 17\./);
  expect(restoreVersion.stdout).toMatch(/PostgreSQL\) 17\./);

  maintenancePool = new Pool({
    host: base.host,
    port: base.port,
    user: base.user,
    database: base.database,
  });

  syntheticDatabase = (
    "cx023_src_" + process.pid + "_" + Date.now().toString(36)
  )
    .toLowerCase()
    .slice(0, 63);

  await maintenancePool.query(
    "create database " + quoteIdentifier(syntheticDatabase),
  );

  syntheticPool = new Pool({
    host: base.host,
    port: base.port,
    user: base.user,
    database: syntheticDatabase,
  });

  await syntheticPool.query(
    [
      "create table cx023_orders (",
      "  id integer primary key,",
      "  code text not null unique,",
      "  amount numeric(10,2) not null check (amount >= 0)",
      ")",
    ].join("\n"),
  );
  await syntheticPool.query(
    [
      "create table cx023_items (",
      "  id integer primary key,",
      "  order_id integer not null references cx023_orders(id),",
      "  label text not null",
      ")",
    ].join("\n"),
  );
  await syntheticPool.query(
    "insert into cx023_orders (id, code, amount) values (1, 'A-1', 10.50), (2, 'B-2', 0.00)",
  );
  await syntheticPool.query(
    "insert into cx023_items (id, order_id, label) values (1, 1, 'alpha'), (2, 1, 'beta'), (3, 2, 'gamma')",
  );

  connection = { ...base, database: syntheticDatabase };

  const outputDirectory = await makeScratchDirectory("dump");
  artifact = await createDump({
    environment: "test",
    connection,
    outputDirectory,
    targetName: "cx023.dump",
  });
}, 60_000);

afterAll(async () => {
  if (syntheticPool !== undefined) {
    await syntheticPool.end();
  }

  if (maintenancePool !== undefined) {
    for (const target of createdTargets) {
      try {
        await dropOwnDatabase(target);
      } catch {
        // Nur Testaufraeumen; der Sandbox-Server wird ohnehin verworfen.
      }
    }
    if (syntheticDatabase !== "") {
      try {
        await dropOwnDatabase(syntheticDatabase);
      } catch {
        // Nur Testaufraeumen.
      }
    }
    await maintenancePool.end();
  }

  for (const directory of scratchDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

describe("CX-023 verifyRestore", () => {
  it(
    "restauriert einen echten CX-022-Dump und prueft Tabellen, Zeilen, Constraints, Hash und Dauer",
    async () => {
      const before = await listRestoreDatabases();
      const sourceBefore = await readSourceState();
      let verifierTarget = "";

      const result = await verifyRestore({
        environment: "test",
        artifact,
        connection,
        verifyContent: async ({ client, targetDatabase }) => {
          verifierTarget = targetDatabase;

          const orders = await client.query<{
            id: number;
            code: string;
            amount: string;
          }>(
            "select id, code, amount::text as amount from cx023_orders order by id",
          );
          expect(orders.rows).toEqual([
            { id: 1, code: "A-1", amount: "10.50" },
            { id: 2, code: "B-2", amount: "0.00" },
          ]);

          const items = await client.query<{
            id: number;
            order_id: number;
            label: string;
          }>(
            "select id, order_id, label from cx023_items order by id",
          );
          expect(items.rows).toEqual([
            { id: 1, order_id: 1, label: "alpha" },
            { id: 2, order_id: 1, label: "beta" },
            { id: 3, order_id: 2, label: "gamma" },
          ]);

          // Constraints muessen mit restauriert worden sein.
          await expect(
            client.query(
              "insert into cx023_orders (id, code, amount) values (3, 'A-1', 1.00)",
            ),
          ).rejects.toThrow();
          await expect(
            client.query(
              "insert into cx023_orders (id, code, amount) values (4, 'C-3', -1.00)",
            ),
          ).rejects.toThrow();
          await expect(
            client.query(
              "insert into cx023_items (id, order_id, label) values (4, 999, 'orphan')",
            ),
          ).rejects.toThrow();

          return true;
        },
      });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.artifactSha256).toBe(artifact.sha256);
      expect(result.verificationPassed).toBe(true);
      expect(result.cleanupSucceeded).toBe(true);
      expect(result.startedAt.endsWith("Z")).toBe(true);
      expect(new Date(result.startedAt).toISOString()).toBe(result.startedAt);
      expect(Number.isInteger(result.restoreDurationMs)).toBe(true);
      expect(result.restoreDurationMs).toBeGreaterThanOrEqual(0);
      expect(result.targetDatabaseName).toMatch(/^gtads_restore_[0-9a-f]{16}$/);
      expect(result.targetDatabaseName).not.toBe(syntheticDatabase);
      expect(verifierTarget).toBe(result.targetDatabaseName);

      expect(await databaseExists(result.targetDatabaseName as string)).toBe(false);
      expect(await listRestoreDatabases()).toEqual(before);
      expect(await readSourceState()).toEqual(sourceBefore);

      const bytes = await readFile(artifact.artifactPath);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        artifact.sha256,
      );
      expect(bytes.byteLength).toBe(artifact.sizeBytes);
    },
    60_000,
  );

  it(
    "restauriert ausschliesslich die geprueften Bytes einer privaten Momentaufnahme",
    async () => {
      const before = await listRestoreDatabases();
      const sourceBefore = await readSourceState();
      const scriptDirectory = await makeScratchDirectory("snapshot");
      const originalPath = join(scriptDirectory, "original.dump");
      const observationPath = join(scriptDirectory, "observed.json");
      await copyFile(artifact.artifactPath, originalPath);

      // Der Fake tauscht den Originalpfad nach der Integritaetspruefung aus
      // und liest danach den Pfad, der tatsaechlich restauriert werden soll.
      const fake = await writeFakePgRestore(
        scriptDirectory,
        "snapshot",
        [
          'const fs = require("node:fs");',
          'const crypto = require("node:crypto");',
          "const dumpPath = process.argv[process.argv.length - 1];",
          "fs.writeFileSync(" + JSON.stringify(originalPath) + ', "manipuliert");',
          "const bytes = fs.readFileSync(dumpPath);",
          "fs.writeFileSync(" +
            JSON.stringify(observationPath) +
            ", JSON.stringify({ path: dumpPath, sha256: crypto.createHash(\"sha256\").update(bytes).digest(\"hex\"), sizeBytes: bytes.byteLength }));",
          "process.exit(0);",
        ].join("\n"),
      );

      const result = await verifyRestore({
        environment: "test",
        artifact: { ...artifact, artifactPath: originalPath },
        connection,
        pgRestoreBinary: fake,
        verifyContent: async () => true,
      });

      expect(result.success).toBe(true);
      const observed = JSON.parse(await readFile(observationPath, "utf8")) as {
        path: string;
        sha256: string;
        sizeBytes: number;
      };
      expect(observed.path).not.toBe(originalPath);
      expect(observed.sha256).toBe(artifact.sha256);
      expect(observed.sizeBytes).toBe(artifact.sizeBytes);

      // Die Momentaufnahme wurde im Cleanup entfernt.
      expect(await pathExists(dirname(observed.path))).toBe(false);
      expect(await pathExists(originalPath)).toBe(true);
      expect(await listRestoreDatabases()).toEqual(before);
      expect(await readSourceState()).toEqual(sourceBefore);
    },
    60_000,
  );

  it(
    "meldet eine nicht entfernte Momentaufnahme als Cleanup-Fehler",
    async () => {
      const before = await listRestoreDatabases();
      const sourceBefore = await readSourceState();
      const scriptDirectory = await makeScratchDirectory("snapshot-cleanup-fail");
      const fake = await writeFakePgRestore(
        scriptDirectory,
        "snapshot-cleanup-fail",
        "process.exit(0);",
      );

      const snapshotDirectories: string[] = [];
      const result = await verifyRestore({
        environment: "test",
        artifact,
        connection,
        pgRestoreBinary: fake,
        removeSnapshotDirectory: async (directory) => {
          snapshotDirectories.push(directory);
          throw new Error("Momentaufnahme ist gesperrt");
        },
        verifyContent: async () => true,
      });

      expect(snapshotDirectories).toHaveLength(1);
      const remainingSnapshot = snapshotDirectories[0] as string;
      // Der Test raeumt die absichtlich zurueckgebliebene Kopie selbst auf.
      scratchDirectories.push(remainingSnapshot);
      expect(await pathExists(remainingSnapshot)).toBe(true);
      await rm(remainingSnapshot, { recursive: true, force: true });

      expect(result.success).toBe(false);
      expect(result.verificationPassed).toBe(true);
      expect(result.cleanupSucceeded).toBe(false);
      expect(result.error?.code).toBe("cleanup_failed");
      expect(result.error?.message).toContain("Momentaufnahme");

      // Die Zieldatenbank wurde trotzdem entfernt; nur die Momentaufnahme
      // blieb zurueck und wird als Cleanup-Fehler gemeldet.
      expect(result.targetDatabaseName).toMatch(/^gtads_restore_[0-9a-f]{16}$/);
      expect(await databaseExists(result.targetDatabaseName as string)).toBe(false);
      expect(await listRestoreDatabases()).toEqual(before);
      expect(await readSourceState()).toEqual(sourceBefore);
    },
    60_000,
  );

  it(
    "weist manipulierte Bytes und eine falsche Byteanzahl vor jeder Datenbankanlage ab",
    async () => {
      const before = await listRestoreDatabases();
      const sourceBefore = await readSourceState();
      const tamperedDirectory = await makeScratchDirectory("tampered");
      const tamperedPath = join(tamperedDirectory, "tampered.dump");

      await copyFile(artifact.artifactPath, tamperedPath);
      const tamperedBytes = await readFile(tamperedPath);
      const index = Math.floor(tamperedBytes.byteLength / 2);
      tamperedBytes[index] = tamperedBytes[index]! ^ 0xff;
      await writeFile(tamperedPath, tamperedBytes);

      const verifierMustNotRun = async (): Promise<boolean> => {
        throw new Error("Die Inhaltspruefung darf bei manipulierten Bytes nicht laufen");
      };

      const tampered = await verifyRestore({
        environment: "test",
        artifact: { ...artifact, artifactPath: tamperedPath },
        connection,
        verifyContent: verifierMustNotRun,
      });

      expect(tampered.success).toBe(false);
      expect(tampered.error?.code).toBe("artifact_integrity_failed");
      expect(tampered.restoreDurationMs).toBe(0);
      expect(tampered.verificationPassed).toBe(false);
      expect(tampered.targetDatabaseName).toBeUndefined();
      expect(await listRestoreDatabases()).toEqual(before);

      const wrongSize = await verifyRestore({
        environment: "test",
        artifact: { ...artifact, sizeBytes: artifact.sizeBytes + 1 },
        connection,
        verifyContent: verifierMustNotRun,
      });

      expect(wrongSize.success).toBe(false);
      expect(wrongSize.error?.code).toBe("artifact_integrity_failed");
      expect(wrongSize.restoreDurationMs).toBe(0);
      expect(wrongSize.verificationPassed).toBe(false);
      expect(wrongSize.targetDatabaseName).toBeUndefined();
      expect(await listRestoreDatabases()).toEqual(before);
      expect(await readSourceState()).toEqual(sourceBefore);

      const originalBytes = await readFile(artifact.artifactPath);
      expect(createHash("sha256").update(originalBytes).digest("hex")).toBe(
        artifact.sha256,
      );
    },
    60_000,
  );

  it(
    "liefert bei Restore- und Inhaltsfehlern keinen Erfolg, laesst die Quelle unveraendert und entfernt das Ziel",
    async () => {
      const before = await listRestoreDatabases();
      const sourceBefore = await readSourceState();
      const scriptDirectory = await makeScratchDirectory("restore-fail");
      const secret = "stderr-secret-cx023";
      const fake = await writeFakePgRestore(
        scriptDirectory,
        "fail",
        [
          'process.stderr.write("password=' + secret + '\\n");',
          "process.exit(1);",
        ].join("\n"),
      );

      let verifierCalls = 0;
      const restoreFailure = await verifyRestore({
        environment: "test",
        artifact,
        connection,
        pgRestoreBinary: fake,
        verifyContent: async () => {
          verifierCalls += 1;
          return true;
        },
      });

      expect(restoreFailure.success).toBe(false);
      expect(restoreFailure.error?.code).toBe("pg_restore_failed");
      expect(restoreFailure.error?.message).not.toContain(secret);
      expect(JSON.stringify(restoreFailure)).not.toContain(secret);
      expect(restoreFailure.verificationPassed).toBe(false);
      expect(restoreFailure.cleanupSucceeded).toBe(true);
      expect(restoreFailure.restoreDurationMs).toBeGreaterThanOrEqual(0);
      expect(verifierCalls).toBe(0);
      expect(await listRestoreDatabases()).toEqual(before);
      expect(await readSourceState()).toEqual(sourceBefore);

      const verificationFailure = await verifyRestore({
        environment: "test",
        artifact,
        connection,
        verifyContent: async ({ client }) => {
          const count = await client.query<{ count: number }>(
            "select count(*)::int as count from cx023_orders",
          );
          // Der echte Restore enthaelt zwei Zeilen; die Pruefung schlaegt
          // daher absichtlich fehl.
          return count.rows[0]?.count !== 2;
        },
      });

      expect(verificationFailure.success).toBe(false);
      expect(verificationFailure.error?.code).toBe("verification_failed");
      expect(verificationFailure.verificationPassed).toBe(false);
      expect(verificationFailure.cleanupSucceeded).toBe(true);
      expect(verificationFailure.targetDatabaseName).toMatch(
        /^gtads_restore_[0-9a-f]{16}$/,
      );
      expect(
        await databaseExists(verificationFailure.targetDatabaseName as string),
      ).toBe(false);
      expect(await listRestoreDatabases()).toEqual(before);
      expect(await readSourceState()).toEqual(sourceBefore);
    },
    60_000,
  );

  it(
    "weist nicht lokale Ziele vor jeder Aenderung ab und macht Aufraeumfehler sichtbar",
    async () => {
      const before = await listRestoreDatabases();
      const scriptDirectory = await makeScratchDirectory("validation");
      const marker = join(scriptDirectory, "spawned.marker");
      const secret = "cx023-connection-secret";
      const fake = await writeFakePgRestore(
        scriptDirectory,
        "marker",
        [
          'require("node:fs").writeFileSync(' +
            JSON.stringify(marker) +
            ', "spawned");',
          "process.exit(0);",
        ].join("\n"),
      );

      const baseOptions = {
        environment: "test",
        artifact,
        connection: { ...connection, password: secret },
        pgRestoreBinary: fake,
        verifyContent: async (): Promise<boolean> => {
          throw new Error("Die Inhaltspruefung darf bei ungueltigen Zielen nicht laufen");
        },
      };

      const remote = await verifyRestore({
        ...baseOptions,
        connection: { ...connection, password: secret, host: "10.20.30.40" },
      });
      expect(remote.success).toBe(false);
      expect(remote.error?.code).toBe("invalid_connection");

      const hostnameTarget = await verifyRestore({
        ...baseOptions,
        connection: { ...connection, password: secret, host: "localhost" },
      });
      expect(hostnameTarget.success).toBe(false);
      expect(hostnameTarget.error?.code).toBe("invalid_connection");

      const wrongEnvironment = await verifyRestore({
        ...baseOptions,
        environment: "prod",
      });
      expect(wrongEnvironment.success).toBe(false);
      expect(wrongEnvironment.error?.code).toBe("invalid_environment");

      const suppliedTarget = await verifyRestore({
        ...baseOptions,
        targetDatabaseName: "gtads_restore_0000000000000000",
      } as unknown as VerifyRestoreOptions);
      expect(suppliedTarget.success).toBe(false);
      expect(suppliedTarget.error?.code).toBe("invalid_options");
      expect(suppliedTarget.targetDatabaseName).toBeUndefined();

      const serialized = JSON.stringify([
        remote,
        hostnameTarget,
        wrongEnvironment,
        suppliedTarget,
      ]);
      expect(serialized).not.toContain(secret);
      expect(await pathExists(marker)).toBe(false);
      expect(await listRestoreDatabases()).toEqual(before);

      let leaked: Client | undefined;
      const cleanupFailure = await verifyRestore({
        environment: "test",
        artifact,
        connection,
        verifyContent: async ({ client, connection: targetConnection }) => {
          const count = await client.query<{ count: number }>(
            "select count(*)::int as count from cx023_orders",
          );
          if (count.rows[0]?.count !== 2) {
            return false;
          }

          // Absichtlich eine zweite Verbindung zur Zieldatenbank offen
          // lassen: DROP DATABASE muss dann real fehlschlagen.
          const extraClient = new Client({
            host: targetConnection.host,
            port: targetConnection.port,
            user: targetConnection.user,
            database: targetConnection.database,
            ...(targetConnection.password === undefined
              ? {}
              : { password: targetConnection.password }),
          });
          leaked = extraClient;
          await extraClient.connect();
          const itemCount = await extraClient.query<{ count: number }>(
            "select count(*)::int as count from cx023_items",
          );
          return itemCount.rows[0]?.count === 3;
        },
      });

      expect(cleanupFailure.verificationPassed).toBe(true);
      expect(cleanupFailure.cleanupSucceeded).toBe(false);
      expect(cleanupFailure.success).toBe(false);
      expect(cleanupFailure.error?.code).toBe("cleanup_failed");
      expect(cleanupFailure.targetDatabaseName).toMatch(
        /^gtads_restore_[0-9a-f]{16}$/,
      );

      const target = cleanupFailure.targetDatabaseName as string;
      createdTargets.add(target);
      expect(await databaseExists(target)).toBe(true);

      if (leaked !== undefined) {
        await leaked.end();
        leaked = undefined;
      }
      await dropOwnDatabase(target);
      createdTargets.delete(target);
      expect(await databaseExists(target)).toBe(false);
      expect(await listRestoreDatabases()).toEqual(before);
    },
    60_000,
  );

  it(
    "behandelt einen Verbindungsabbruch der Wartungsverbindung waehrend des Restores kontrolliert",
    async () => {
      const before = await listRestoreDatabases();
      const sourceBefore = await readSourceState();
      const scriptDirectory = await makeScratchDirectory("restore-disconnect");
      const startedMarker = join(scriptDirectory, "started.marker");
      const releaseMarker = join(scriptDirectory, "release.marker");

      // Der Fake signalisiert den Start und wartet, bis der Test die
      // Wartungsverbindung getrennt hat.
      const fake = await writeFakePgRestore(
        scriptDirectory,
        "disconnect",
        [
          "(async () => {",
          '  const fs = require("node:fs");',
          '  const { setTimeout: delay } = require("node:timers/promises");',
          "  fs.writeFileSync(" + JSON.stringify(startedMarker) + ', "started");',
          "  for (let attempt = 0; attempt < 600; attempt += 1) {",
          "    if (fs.existsSync(" + JSON.stringify(releaseMarker) + ")) {",
          "      break;",
          "    }",
          "    await delay(25);",
          "  }",
          "  await delay(500);",
          "  process.exit(0);",
          "})().catch(() => {",
          "  process.exit(2);",
          "});",
        ].join("\n"),
      );

      // Bestehende Pool-Verbindungen merken, damit ausschliesslich die
      // Wartungsverbindung des Aufrufs getrennt wird.
      await syntheticPool.query("select 1");
      const existing = await maintenancePool.query<{ pid: number }>(
        "select pid from pg_stat_activity where datname = $1",
        [syntheticDatabase],
      );
      const existingPids = existing.rows.map((row) => row.pid);

      let verifyCalls = 0;
      const pending = verifyRestore({
        environment: "test",
        artifact,
        connection,
        pgRestoreBinary: fake,
        verifyContent: async () => {
          verifyCalls += 1;
          return true;
        },
      });

      await waitForPath(startedMarker, 15_000);
      const terminated = await maintenancePool.query(
        [
          "select pg_terminate_backend(pid)",
          "from pg_stat_activity",
          "where datname = $1 and not (pid = any($2::int[]))",
        ].join(" "),
        [syntheticDatabase, existingPids],
      );
      expect(terminated.rowCount).toBeGreaterThan(0);
      await writeFile(releaseMarker, "release");

      const result = await pending;

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("source_connection_failed");
      expect(result.verificationPassed).toBe(false);
      expect(result.cleanupSucceeded).toBe(true);
      expect(verifyCalls).toBe(0);
      expect(result.targetDatabaseName).toMatch(/^gtads_restore_[0-9a-f]{16}$/);
      expect(await databaseExists(result.targetDatabaseName as string)).toBe(false);
      expect(await listRestoreDatabases()).toEqual(before);
      expect(await readSourceState()).toEqual(sourceBefore);
    },
    60_000,
  );

});
