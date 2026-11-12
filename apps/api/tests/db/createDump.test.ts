import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDump,
  DumpError,
  type CreateDumpOptions,
  type LocalDumpConnection,
} from "../../src/modules/backup/createDump.js";

const scratchDirectories: string[] = [];

let maintenancePool: Pool | undefined;
let syntheticPool: Pool | undefined;
let syntheticDatabase = "";
let connection: LocalDumpConnection;

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
  const directory = await mkdtemp(join(tmpdir(), "cx022-" + label + "-"));
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
      "CX-022 benoetigt das PostgreSQL-Testsetup: with-postgres <befehl>",
    );
  }

  return { host, port, database, user };
}

async function writeFakePgDump(
  directory: string,
  name: string,
  body: string,
): Promise<string> {
  const path = join(directory, "fake-" + name + ".cjs");
  await writeFile(path, "#!/usr/bin/env node\n" + body, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

async function rejectDump(options: CreateDumpOptions): Promise<DumpError> {
  try {
    await createDump(options);
  } catch (error) {
    if (error instanceof DumpError) {
      return error;
    }
    throw error;
  }
  throw new Error("createDump war unerwartet erfolgreich");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pathExists(path)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Erwartete Datei wurde nicht erzeugt: " + path);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Der gestartete Prozess laeuft nach dem Abbruch weiter");
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
    "cx022_synth_" + process.pid + "_" + Date.now().toString(36)
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
    "create table cx022_synthetic (id integer primary key, note text not null)",
  );
  await syntheticPool.query(
    "insert into cx022_synthetic (id, note) values (1, 'alpha'), (2, 'beta')",
  );

  connection = { ...base, database: syntheticDatabase };
});

afterAll(async () => {
  if (syntheticPool !== undefined) {
    await syntheticPool.end();
  }

  if (maintenancePool !== undefined) {
    if (syntheticDatabase !== "") {
      await maintenancePool.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [syntheticDatabase],
      );
      await maintenancePool.query(
        "drop database if exists " + quoteIdentifier(syntheticDatabase),
      );
    }
    await maintenancePool.end();
  }

  for (const directory of scratchDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("CX-022 createDump", () => {
  it("sichert eine synthetische Datenbank mit echtem pg_dump und prueft SHA-256, Byteanzahl und pg_restore --list", async () => {
    const outputDirectory = await makeScratchDirectory("out-real");

    const artifact = await createDump({
      environment: "test",
      connection,
      outputDirectory,
      targetName: "sandbox.dump",
    });

    expect(artifact.format).toBe("postgres-custom");
    expect(dirname(artifact.artifactPath)).not.toBe(outputDirectory);
    expect(artifact.artifactPath.startsWith(outputDirectory + "/")).toBe(true);
    expect(artifact.artifactPath.endsWith("/sandbox.dump")).toBe(true);
    expect(new Date(artifact.createdAt).toISOString()).toBe(artifact.createdAt);
    expect(artifact.durationMs).toBeGreaterThanOrEqual(0);

    const bytes = await readFile(artifact.artifactPath);
    expect(artifact.sizeBytes).toBe(bytes.byteLength);
    expect(artifact.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );

    const artifactStat = await stat(artifact.artifactPath);
    expect(artifactStat.mode & 0o777).toBe(0o600);
    const directoryStat = await stat(dirname(artifact.artifactPath));
    expect(directoryStat.mode & 0o777).toBe(0o700);

    const restore = await run("pg_restore", ["--list", artifact.artifactPath]);
    expect(restore.stdout).toContain("cx022_synthetic");
  });

  it("erzeugt bei Prozessfehler nach Teiloutput kein Artefakt und entfernt die eigene temporaere Datei", async () => {
    const outputDirectory = await makeScratchDirectory("out-partial");
    const scriptDirectory = await makeScratchDirectory("script-partial");
    const secret = "stderr-secret-cx022";
    const fake = await writeFakePgDump(
      scriptDirectory,
      "partial",
      [
        'const fs = require("node:fs");',
        'const fileArg = process.argv.find((arg) => arg.startsWith("--file="));',
        "if (!fileArg) process.exit(2);",
        'fs.writeFileSync(fileArg.slice("--file=".length), "partial-dump-bytes");',
        "process.stderr.write(" +
          JSON.stringify("password=" + secret + "\n") +
          ");",
        "process.exit(1);",
      ].join("\n"),
    );

    const error = await rejectDump({
      environment: "test",
      connection,
      outputDirectory,
      targetName: "partial.dump",
      pgDumpBinary: fake,
    });

    expect(error.code).toBe("pg_dump_failed");
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("partial-dump-bytes");
    expect("artifactPath" in error).toBe(false);
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  it("beendet den Prozess bei Timeout und Abbruch und entfernt nur die eigenen unvollstaendigen Dateien", async () => {
    const outputDirectory = await makeScratchDirectory("out-terminate");
    const scriptDirectory = await makeScratchDirectory("script-terminate");
    const pidFile = join(scriptDirectory, "pid.txt");
    await writeFile(join(outputDirectory, "unrelated.txt"), "keep");

    const fake = await writeFakePgDump(
      scriptDirectory,
      "hang",
      [
        'const fs = require("node:fs");',
        "fs.writeFileSync(" + JSON.stringify(pidFile) + ", String(process.pid));",
        'const fileArg = process.argv.find((arg) => arg.startsWith("--file="));',
        "if (!fileArg) process.exit(2);",
        'fs.writeFileSync(fileArg.slice("--file=".length), "partial-dump-bytes");',
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );

    const timeoutError = await rejectDump({
      environment: "test",
      connection,
      outputDirectory,
      targetName: "timeout.dump",
      timeoutMs: 400,
      pgDumpBinary: fake,
    });

    expect(timeoutError.code).toBe("timeout");
    const timeoutPid = Number(await readFile(pidFile, "utf8"));
    expect(Number.isInteger(timeoutPid)).toBe(true);
    await waitForProcessExit(timeoutPid);
    expect(await readdir(outputDirectory)).toEqual(["unrelated.txt"]);
    expect(await readFile(join(outputDirectory, "unrelated.txt"), "utf8")).toBe(
      "keep",
    );

    await rm(pidFile, { force: true });

    const controller = new AbortController();
    const abortSettled = createDump({
      environment: "test",
      connection,
      outputDirectory,
      targetName: "abort.dump",
      timeoutMs: 5000,
      signal: controller.signal,
      pgDumpBinary: fake,
    }).then(
      () => {
        throw new Error("createDump war beim Abbruch unerwartet erfolgreich");
      },
      (error: unknown) => error,
    );

    await waitForFile(pidFile);
    controller.abort();

    const abortError = await abortSettled;
    expect(abortError).toBeInstanceOf(DumpError);
    expect((abortError as DumpError).code).toBe("aborted");

    const abortPid = Number(await readFile(pidFile, "utf8"));
    expect(Number.isInteger(abortPid)).toBe(true);
    await waitForProcessExit(abortPid);
    expect(await readdir(outputDirectory)).toEqual(["unrelated.txt"]);
  });

  it("weist unerlaubte Umgebung, nicht lokales Ziel und belegten Zielnamen vor dem Prozessstart ab", async () => {
    const outputDirectory = await makeScratchDirectory("out-validation");
    const scriptDirectory = await makeScratchDirectory("script-validation");
    const marker = join(scriptDirectory, "spawned.marker");
    const secret = "cx022-connection-secret";
    const fake = await writeFakePgDump(
      scriptDirectory,
      "marker",
      [
        'require("node:fs").writeFileSync(' +
          JSON.stringify(marker) +
          ', "spawned");',
        "process.exit(0);",
      ].join("\n"),
    );

    const base = { ...connection, password: secret };
    const errors: string[] = [];

    const invalidEnvironment = await rejectDump({
      environment: "prod",
      connection: base,
      outputDirectory,
      targetName: "env.dump",
      pgDumpBinary: fake,
    });
    expect(invalidEnvironment.code).toBe("invalid_environment");
    errors.push(String(invalidEnvironment));

    const remoteTarget = await rejectDump({
      environment: "test",
      connection: { ...base, host: "10.20.30.40" },
      outputDirectory,
      targetName: "remote.dump",
      pgDumpBinary: fake,
    });
    expect(remoteTarget.code).toBe("invalid_connection");
    errors.push(String(remoteTarget));

    const existingTarget = join(outputDirectory, "existing.dump");
    await writeFile(existingTarget, "keep");
    const existing = await rejectDump({
      environment: "test",
      connection: base,
      outputDirectory,
      targetName: "existing.dump",
      pgDumpBinary: fake,
    });
    expect(existing.code).toBe("target_exists");
    errors.push(String(existing));

    expect(errors.join("\n")).not.toContain(secret);
    expect(await pathExists(marker)).toBe(false);
    expect(await readdir(outputDirectory)).toEqual(["existing.dump"]);
    expect(await readFile(existingTarget, "utf8")).toBe("keep");
  });
});

