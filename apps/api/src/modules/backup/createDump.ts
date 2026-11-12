import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";

/**
 * Interner Service fuer lokale PostgreSQL-Custom-Dumps (CX-022).
 *
 * Bewusste Grenzen:
 * - Es gibt keinen HTTP-, Scheduler- oder Serverkonfigurationsbezug.
 * - Verbindungsdaten kommen ausschliesslich als explizite Parameter herein.
 *   Es wird keine Verbindungszeichenfolge aus process.env gelesen.
 * - Passwoerter werden nur ueber die fuer pg_dump zusammengestellte
 *   Kindprozess-Umgebung uebergeben, nie als Argument oder in Fehlern.
 */

export const DEFAULT_DUMP_TIMEOUT_MS = 30_000;
export const MAX_DUMP_TIMEOUT_MS = 120_000;

const TARGET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;

export type DumpErrorCode =
  | "invalid_environment"
  | "invalid_connection"
  | "invalid_output_directory"
  | "invalid_timeout"
  | "invalid_target_name"
  | "target_exists"
  | "pg_dump_missing"
  | "pg_dump_failed"
  | "timeout"
  | "aborted"
  | "artifact_io_error";

/**
 * Bereinigter Fehler. Die Meldung enthaelt keine Verbindungsdaten und keinen
 * ungefilterten stderr-Inhalt des Kindprozesses.
 */
export class DumpError extends Error {
  readonly code: DumpErrorCode;

  constructor(code: DumpErrorCode, message: string) {
    super(message);
    this.name = "DumpError";
    this.code = code;
  }
}

/**
 * Explizite lokale Sandbox-Verbindung.
 *
 * host ist entweder ein absoluter Unix-Socket-Ordner oder eine der
 * Loopback-Adressen 127.0.0.1 / ::1. Namen wie "localhost" oder entfernte
 * Adressen werden absichtlich abgewiesen.
 */
export interface LocalDumpConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  /** Optional; wird ausschliesslich als PGPASSWORD an den Kindprozess gegeben. */
  password?: string;
}

export interface CreateDumpOptions {
  /** Nur "test" ist zulaessig. */
  environment: string;
  connection: LocalDumpConnection;
  /** Absolutes, bereits vorhandenes Verzeichnis. */
  outputDirectory: string;
  /** Optionaler Abbruch. Beendet den gestarteten pg_dump-Prozess. */
  signal?: AbortSignal;
  /** Standard 30 s; auf MAX_DUMP_TIMEOUT_MS begrenzt. */
  timeoutMs?: number;
  /** Name der veroeffentlichten Datei; Standard "dump.pgdump". */
  targetName?: string;
  /**
   * Testnaht fuer gezielte Prozessfehler/Abbruch. Im Normalbetrieb bleibt
   * dies ungesetzt, dann wird "pg_dump" aus dem PATH verwendet.
   */
  pgDumpBinary?: string;
}

export interface DumpArtifact {
  artifactPath: string;
  sha256: string;
  sizeBytes: number;
  format: "postgres-custom";
  /** UTC-Zeit im ISO-8601-Format. */
  createdAt: string;
  durationMs: number;
}

function fail(code: DumpErrorCode, message: string): never {
  throw new DumpError(code, message);
}

function normalizeLocalHost(host: unknown): string {
  if (typeof host !== "string") {
    fail(
      "invalid_connection",
      "Die Datenbankverbindung muss ueber einen lokalen Unix-Socket oder Loopback erfolgen",
    );
  }
  if (host === "::1" || host === "[::1]") {
    return "::1";
  }
  if (host === "127.0.0.1") {
    return "127.0.0.1";
  }
  if (isAbsolute(host) && !host.includes("\0")) {
    return host;
  }
  fail(
    "invalid_connection",
    "Die Datenbankverbindung muss ueber einen lokalen Unix-Socket oder Loopback erfolgen",
  );
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

async function validateConnection(
  connection: LocalDumpConnection | undefined,
): Promise<LocalDumpConnection> {
  if (connection === undefined || connection === null || typeof connection !== "object") {
    fail("invalid_connection", "Es wurde keine gueltige lokale Datenbankverbindung angegeben");
  }

  if (
    !Number.isInteger(connection.port) ||
    connection.port < 1 ||
    connection.port > 65_535
  ) {
    fail("invalid_connection", "Der lokale Datenbankport ist ungueltig");
  }

  if (!isSafeIdentifier(connection.database) || !isSafeIdentifier(connection.user)) {
    fail("invalid_connection", "Datenbankname oder Benutzer sind ungueltig");
  }

  if (
    connection.password !== undefined &&
    (typeof connection.password !== "string" || connection.password.includes("\0"))
  ) {
    fail("invalid_connection", "Das Verbindungspasswort ist ungueltig");
  }

  const host = normalizeLocalHost(connection.host);

  if (host !== "127.0.0.1" && host !== "::1") {
    let stats;
    try {
      stats = await lstat(host);
    } catch {
      fail("invalid_connection", "Der lokale Unix-Socket-Ordner ist nicht vorhanden");
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      fail("invalid_connection", "Der lokale Unix-Socket-Pfad ist kein Verzeichnis");
    }
  }

  return {
    host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    ...(connection.password === undefined ? {} : { password: connection.password }),
  };
}

async function validateOutputDirectory(value: unknown): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    fail("invalid_output_directory", "Das Ausgabeverzeichnis muss ein absoluter Pfad sein");
  }

  let stats;
  try {
    stats = await lstat(value);
  } catch {
    fail("invalid_output_directory", "Das Ausgabeverzeichnis ist nicht vorhanden");
  }

  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail("invalid_output_directory", "Das Ausgabeverzeichnis ist kein Verzeichnis");
  }

  return value;
}

function resolveTimeout(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_DUMP_TIMEOUT_MS;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_DUMP_TIMEOUT_MS
  ) {
    fail(
      "invalid_timeout",
      "Das Zeitlimit muss eine ganze Zahl zwischen 1 und " +
        String(MAX_DUMP_TIMEOUT_MS) +
        " Millisekunden sein",
    );
  }
  return value;
}

function resolveTargetName(value: unknown): string {
  const targetName = value === undefined ? "dump.pgdump" : value;
  if (typeof targetName !== "string" || !TARGET_NAME_PATTERN.test(targetName)) {
    fail("invalid_target_name", "Der Zielname ist ungueltig");
  }
  return targetName;
}

async function assertTargetAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    fail("artifact_io_error", "Der Zielpfad konnte nicht geprueft werden");
  }
  fail("target_exists", "Der Zielname ist bereits belegt");
}

function buildChildEnvironment(connection: LocalDumpConnection): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    PGHOST: connection.host,
    PGPORT: String(connection.port),
    PGDATABASE: connection.database,
    PGUSER: connection.user,
    PGSSLMODE: "disable",
    PGCONNECT_TIMEOUT: "10",
  };

  if (connection.password !== undefined) {
    env.PGPASSWORD = connection.password;
  }

  return env;
}

const KILL_GRACE_MS = 500;

interface RunPgDumpOptions {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Startet pg_dump ohne Shell. stderr wird bewusst verworfen und nie in eine
 * Fehlermeldung uebernommen. Bei Timeout/Abbruch wird der Prozess beendet;
 * erst nach dem close-Ereignis wird entschieden.
 */
function runPgDump(options: RunPgDumpOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(options.binary, options.args, {
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
        env: options.env,
        windowsHide: true,
      });
    } catch {
      reject(new DumpError("pg_dump_failed", "pg_dump konnte nicht gestartet werden"));
      return;
    }

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;

    const clearTimers = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };

    const finish = (error?: DumpError): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      if (abortListener !== undefined && options.signal !== undefined) {
        options.signal.removeEventListener("abort", abortListener);
      }
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };

    const terminate = (): void => {
      if (settled) {
        return;
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // Der Prozess kann bereits beendet sein. Der close-Handler entscheidet.
      }
      if (killTimer === undefined) {
        killTimer = setTimeout(() => {
          if (settled) {
            return;
          }
          try {
            child.kill("SIGKILL");
          } catch {
            // Kein weiterer Handlungsbedarf; close/error schliessen ab.
          }
        }, KILL_GRACE_MS);
      }
    };

    abortListener = (): void => {
      if (settled) {
        return;
      }
      aborted = true;
      terminate();
    };

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        aborted = true;
        terminate();
      } else {
        options.signal.addEventListener("abort", abortListener, { once: true });
      }
    }

    timeoutTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      terminate();
    }, options.timeoutMs);

    // stderr muss abgeflossen werden, damit der Kindprozess nicht blockiert.
    // Die Inhalte werden absichtlich nicht gespeichert oder weitergegeben.
    child.stderr?.on("data", () => {
      // verworfen
    });
    child.stderr?.on("error", () => {
      // verworfen
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        finish(new DumpError("pg_dump_missing", "pg_dump wurde nicht gefunden"));
      } else {
        finish(new DumpError("pg_dump_failed", "pg_dump konnte nicht gestartet werden"));
      }
    });

    child.once("close", (code) => {
      if (settled) {
        return;
      }
      if (timedOut) {
        finish(new DumpError("timeout", "Der Dump hat das Zeitlimit ueberschritten"));
        return;
      }
      if (aborted) {
        finish(new DumpError("aborted", "Der Dump wurde abgebrochen"));
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      finish(new DumpError("pg_dump_failed", "pg_dump ist fehlgeschlagen"));
    });
  });
}

async function hashFile(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const stream = createReadStream(path);

  try {
    for await (const chunk of stream) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      hash.update(buffer);
      sizeBytes += buffer.length;
    }
  } finally {
    stream.destroy();
  }

  return { sha256: hash.digest("hex"), sizeBytes };
}

async function removeOwnTempDirectory(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    // Ein fehlgeschlagenes Aufraeumen darf die bereinigte Fehlerkategorie
    // nicht durch eine ungefilterte IO-Meldung ersetzen.
  }
}

/**
 * Erstellt ein lokales PostgreSQL-Custom-Format-Dumpartefakt.
 *
 * Die Datei wird zunaechst als partielle Datei in einem privaten temporaeren
 * Unterordner (Modus 0700) geschrieben. Erst nach erfolgreichem Prozessende
 * werden SHA-256 und Byteanzahl inkrementell berechnet und die Datei innerhalb
 * dieses Ordners auf ihren Zielnamen umbenannt. Bei jedem Fehlschlag wird
 * ausschliesslich der eigene temporaere Ordner entfernt.
 */
export async function createDump(options: CreateDumpOptions): Promise<DumpArtifact> {
  const startedAt = performance.now();

  if (options === undefined || options === null || typeof options !== "object") {
    fail("invalid_environment", "Es wurden keine Dump-Optionen angegeben");
  }

  if (options.environment !== "test") {
    fail("invalid_environment", "Dumps sind ausschliesslich in der Umgebung test erlaubt");
  }

  const connection = await validateConnection(options.connection);
  const outputDirectory = await validateOutputDirectory(options.outputDirectory);
  const timeoutMs = resolveTimeout(options.timeoutMs);
  const targetName = resolveTargetName(options.targetName);
  const pgDumpBinary =
    options.pgDumpBinary === undefined ? "pg_dump" : options.pgDumpBinary;

  if (typeof pgDumpBinary !== "string" || pgDumpBinary.trim() === "") {
    fail("pg_dump_missing", "pg_dump wurde nicht gefunden");
  }

  if (options.signal?.aborted === true) {
    fail("aborted", "Der Dump wurde abgebrochen");
  }

  // Ein bereits belegter Zielname wird vor jedem Prozessstart abgewiesen.
  await assertTargetAbsent(join(outputDirectory, targetName));

  let tempDirectory: string | undefined;

  try {
    tempDirectory = await mkdtemp(join(outputDirectory, ".cx022-dump-"));
    await chmod(tempDirectory, 0o700);

    const artifactPath = join(tempDirectory, targetName);
    const partialPath = join(tempDirectory, "." + targetName + ".partial");

    await assertTargetAbsent(artifactPath);
    await writeFile(partialPath, "", { flag: "wx", mode: 0o600 });
    await chmod(partialPath, 0o600);

    await runPgDump({
      binary: pgDumpBinary,
      args: [
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--file=" + partialPath,
      ],
      env: buildChildEnvironment(connection),
      timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    // Erst nach dem Prozessabschluss: inkrementelle Pruefsumme und Groesse.
    const { sha256, sizeBytes } = await hashFile(partialPath);
    await chmod(partialPath, 0o600);
    await rename(partialPath, artifactPath);

    return {
      artifactPath,
      sha256,
      sizeBytes,
      format: "postgres-custom",
      createdAt: new Date().toISOString(),
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  } catch (error) {
    if (tempDirectory !== undefined) {
      await removeOwnTempDirectory(tempDirectory);
    }
    if (error instanceof DumpError) {
      throw error;
    }
    throw new DumpError("artifact_io_error", "Das Dumpartefakt konnte nicht erstellt werden");
  }
}

