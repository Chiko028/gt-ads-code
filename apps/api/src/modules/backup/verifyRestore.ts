import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { Client, type ClientConfig } from "pg";
import type { DumpArtifact } from "./createDump.js";

/**
 * Interner Service fuer den lokalen Restore-Nachweis (CX-023).
 *
 * Bewusste Grenzen:
 * - Es gibt keinen HTTP-, Scheduler- oder Serverkonfigurationsbezug.
 * - Der Aufrufer liefert eine explizite lokale Sandbox-Verbindung. Es wird
 *   keine Verbindungszeichenfolge aus process.env gelesen.
 * - Der Name der Zieldatenbank wird ausschliesslich hier erzeugt. Ein vom
 *   Aufrufer gelieferter Zieldatenbankname wird abgewiesen.
 * - Es werden weder Serverrechte noch Rollen veraendert. Angelegt und
 *   entfernt wird ausschliesslich die in diesem Aufruf erzeugte Datenbank.
 * - Passwoerter werden nur ueber die Kindprozess-Umgebung uebergeben und
 *   erscheinen nie in Ergebnissen oder Fehlermeldungen.
 */

export const DEFAULT_RESTORE_TIMEOUT_MS = 60_000;
export const MAX_RESTORE_TIMEOUT_MS = 300_000;

const TARGET_NAME_PREFIX = "gtads_restore_";
const TARGET_NAME_PATTERN = /^gtads_restore_[0-9a-f]{16}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;
const TARGET_NAME_ATTEMPTS = 8;
const KILL_GRACE_MS = 500;

export type RestoreErrorCode =
  | "invalid_options"
  | "invalid_environment"
  | "invalid_artifact"
  | "artifact_integrity_failed"
  | "invalid_connection"
  | "invalid_timeout"
  | "aborted"
  | "source_connection_failed"
  | "database_create_failed"
  | "pg_restore_missing"
  | "pg_restore_failed"
  | "timeout"
  | "target_connection_failed"
  | "verification_failed"
  | "cleanup_failed"
  | "internal_error";

/** Bereinigter Fehler ohne Verbindungsdaten, Passwoerter oder rohe SQL-Texte. */
export interface RestoreError {
  code: RestoreErrorCode;
  message: string;
}

/**
 * Explizite lokale Sandbox-Verbindung.
 *
 * host ist entweder ein absoluter Unix-Socket-Ordner oder eine der
 * Loopback-Adressen 127.0.0.1 / ::1. Namen wie "localhost" oder entfernte
 * Adressen werden absichtlich abgewiesen.
 */
export interface LocalRestoreConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  /** Optional; wird ausschliesslich als PGPASSWORD an Kindprozesse gegeben. */
  password?: string;
}

/** Kontext fuer die vom internen Aufrufer gelieferte Inhaltspruefung. */
export interface RestoreVerificationContext {
  /** Separater Client, bereits mit der restaurierten Zieldatenbank verbunden. */
  client: Client;
  targetDatabase: string;
  connection: LocalRestoreConnection;
}

export type RestoreContentVerifier = (
  context: RestoreVerificationContext,
) => Promise<boolean>;

export interface VerifyRestoreOptions {
  /** Nur "test" ist zulaessig. */
  environment: string;
  /** Artefaktdeskriptor aus CX-022. */
  artifact: DumpArtifact;
  connection: LocalRestoreConnection;
  /** Interne Inhaltspruefung; wird nach erfolgreichem Restore aufgerufen. */
  verifyContent: RestoreContentVerifier;
  /** Standard 60 s; auf MAX_RESTORE_TIMEOUT_MS begrenzt. */
  timeoutMs?: number;
  /** Optionaler Abbruch. Beendet den gestarteten pg_restore-Prozess. */
  signal?: AbortSignal;
  /**
   * Testnaht fuer gezielte Prozessfehler/Abbruch. Im Normalbetrieb bleibt
   * dies ungesetzt, dann wird "pg_restore" aus dem PATH verwendet.
   */
  pgRestoreBinary?: string;
}

/**
 * Stabil typisiertes Ergebnis. success ist nur true, wenn Restore,
 * Inhaltspruefung und Aufraeumen erfolgreich waren.
 */
export interface VerifyRestoreResult {
  success: boolean;
  artifactSha256: string;
  /** UTC-Zeit im ISO-8601-Format. */
  startedAt: string;
  restoreDurationMs: number;
  verificationPassed: boolean;
  cleanupSucceeded: boolean;
  targetDatabaseName?: string;
  error?: RestoreError;
}

class RestoreFailure extends Error {
  readonly code: RestoreErrorCode;

  constructor(code: RestoreErrorCode, message: string) {
    super(message);
    this.name = "RestoreFailure";
    this.code = code;
  }
}

function fail(code: RestoreErrorCode, message: string): never {
  throw new RestoreFailure(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  connection: unknown,
): Promise<LocalRestoreConnection> {
  if (!isRecord(connection)) {
    fail("invalid_connection", "Es wurde keine gueltige lokale Datenbankverbindung angegeben");
  }

  const port = connection.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    fail("invalid_connection", "Der lokale Datenbankport ist ungueltig");
  }

  if (!isSafeIdentifier(connection.database) || !isSafeIdentifier(connection.user)) {
    fail("invalid_connection", "Datenbankname oder Benutzer sind ungueltig");
  }

  const password = connection.password;
  if (
    password !== undefined &&
    (typeof password !== "string" || password.includes("\0"))
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
    port,
    database: connection.database,
    user: connection.user,
    ...(password === undefined ? {} : { password }),
  };
}

interface ValidatedArtifact {
  artifactPath: string;
  sha256: string;
  sizeBytes: number;
}

async function validateArtifact(value: unknown): Promise<ValidatedArtifact> {
  if (!isRecord(value)) {
    fail("invalid_artifact", "Es wurde kein gueltiger Artefaktdeskriptor angegeben");
  }

  if (value.format !== "postgres-custom") {
    fail("invalid_artifact", "Das Dumpartefakt hat kein unterstuetztes Format");
  }

  const artifactPath = value.artifactPath;
  if (
    typeof artifactPath !== "string" ||
    !isAbsolute(artifactPath) ||
    artifactPath.includes("\0")
  ) {
    fail("invalid_artifact", "Der Artefaktpfad muss ein absoluter Pfad sein");
  }

  const sha256 = value.sha256;
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
    fail("invalid_artifact", "Die SHA-256-Pruefsumme des Artefakts ist ungueltig");
  }

  const sizeBytes = value.sizeBytes;
  if (
    typeof sizeBytes !== "number" ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0
  ) {
    fail("invalid_artifact", "Die Byteanzahl des Artefakts ist ungueltig");
  }

  let stats;
  try {
    stats = await lstat(artifactPath);
  } catch {
    fail("invalid_artifact", "Das Dumpartefakt ist nicht vorhanden");
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    fail("invalid_artifact", "Das Dumpartefakt ist keine regulaere Datei");
  }

  return { artifactPath, sha256, sizeBytes };
}

/**
 * Prueft SHA-256 und Byteanzahl vollstaendig, bevor irgendein
 * Datenbankclient erzeugt oder eine Datenbank angelegt wird.
 */
async function verifyArtifactIntegrity(artifact: ValidatedArtifact): Promise<void> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const stream = createReadStream(artifact.artifactPath);

  try {
    for await (const chunk of stream) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      hash.update(buffer);
      sizeBytes += buffer.length;
    }
  } catch {
    fail("artifact_integrity_failed", "Das Dumpartefakt konnte nicht gelesen werden");
  } finally {
    stream.destroy();
  }

  if (sizeBytes !== artifact.sizeBytes || hash.digest("hex") !== artifact.sha256) {
    fail(
      "artifact_integrity_failed",
      "Pruefsumme oder Byteanzahl des Dumpartefakts stimmen nicht",
    );
  }
}

function resolveTimeout(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_RESTORE_TIMEOUT_MS;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_RESTORE_TIMEOUT_MS
  ) {
    fail(
      "invalid_timeout",
      "Das Zeitlimit muss eine ganze Zahl zwischen 1 und " +
        String(MAX_RESTORE_TIMEOUT_MS) +
        " Millisekunden sein",
    );
  }
  return value;
}

function resolveVerifier(value: unknown): RestoreContentVerifier {
  if (typeof value !== "function") {
    fail("invalid_options", "Es wurde keine Inhaltspruefung angegeben");
  }
  return value as RestoreContentVerifier;
}

function resolveBinary(value: unknown): string {
  if (value === undefined) {
    return "pg_restore";
  }
  if (typeof value !== "string" || value.trim() === "") {
    fail("pg_restore_missing", "pg_restore wurde nicht gefunden");
  }
  return value;
}

function quoteIdentifier(identifier: string): string {
  return '"' + identifier.replace(/"/g, '""') + '"';
}

function clientConfig(connection: LocalRestoreConnection): ClientConfig {
  return {
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    ...(connection.password === undefined ? {} : { password: connection.password }),
  };
}

function buildChildEnvironment(connection: LocalRestoreConnection): NodeJS.ProcessEnv {
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

interface RunPgRestoreOptions {
  binary: string;
  /** Ausschliesslich intern erzeugter Zieldatenbankname. */
  databaseName: string;
  artifactPath: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Startet pg_restore ohne Shell. Es werden ausschliesslich die geforderten
 * Optionen verwendet: kein --clean, kein --create, kein vom Aufrufer
 * bestimmter Datenbankname. stderr wird verworfen und nie in eine
 * Fehlermeldung uebernommen. Bei Timeout/Abbruch wird der Prozess beendet;
 * entschieden wird erst nach dem close-Ereignis.
 */
function runPgRestore(options: RunPgRestoreOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(
        options.binary,
        [
          "--exit-on-error",
          "--single-transaction",
          "--no-owner",
          "--no-privileges",
          "--dbname=" + options.databaseName,
          options.artifactPath,
        ],
        {
          shell: false,
          stdio: ["ignore", "ignore", "pipe"],
          env: options.env,
          windowsHide: true,
        },
      );
    } catch {
      reject(new RestoreFailure("pg_restore_failed", "pg_restore konnte nicht gestartet werden"));
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

    const finish = (error?: RestoreFailure): void => {
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

    // stderr muss abfliessen, damit der Kindprozess nicht blockiert.
    // Die Inhalte werden absichtlich nicht gespeichert oder weitergegeben.
    child.stderr?.on("data", () => {
      // verworfen
    });
    child.stderr?.on("error", () => {
      // verworfen
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        finish(new RestoreFailure("pg_restore_missing", "pg_restore wurde nicht gefunden"));
      } else {
        finish(
          new RestoreFailure("pg_restore_failed", "pg_restore konnte nicht gestartet werden"),
        );
      }
    });

    child.once("close", (code) => {
      if (settled) {
        return;
      }
      if (timedOut) {
        finish(new RestoreFailure("timeout", "Der Restore hat das Zeitlimit ueberschritten"));
        return;
      }
      if (aborted) {
        finish(new RestoreFailure("aborted", "Der Restore wurde abgebrochen"));
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      finish(new RestoreFailure("pg_restore_failed", "pg_restore ist fehlgeschlagen"));
    });
  });
}

/**
 * Erzeugt einen eigenen, nicht vom Aufrufer bestimmbaren Zieldatenbanknamen
 * und legt die Datenbank an. Kollidiert der Zufallsname mit der Quelle oder
 * einer vorhandenen Datenbank, wird ein neuer Name versucht.
 */
async function createTargetDatabase(
  client: Client,
  sourceDatabase: string,
): Promise<string> {
  for (let attempt = 0; attempt < TARGET_NAME_ATTEMPTS; attempt += 1) {
    const candidate = TARGET_NAME_PREFIX + randomBytes(8).toString("hex");
    if (!TARGET_NAME_PATTERN.test(candidate) || candidate === sourceDatabase) {
      continue;
    }

    let existing;
    try {
      existing = await client.query("select 1 from pg_database where datname = $1", [
        candidate,
      ]);
    } catch {
      fail("database_create_failed", "Der Zieldatenbankname konnte nicht geprueft werden");
    }

    if (existing.rowCount !== 0) {
      continue;
    }

    try {
      await client.query("create database " + quoteIdentifier(candidate));
    } catch {
      fail(
        "database_create_failed",
        "Die Zieldatenbank konnte nicht erstellt werden (CREATEDB-Recht in der Sandbox pruefen)",
      );
    }

    return candidate;
  }

  fail("database_create_failed", "Es konnte kein freier Zieldatenbankname erzeugt werden");
}

function toRestoreError(error: unknown): RestoreError {
  if (error instanceof RestoreFailure) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "internal_error",
    message: "Der Restore-Nachweis ist unerwartet fehlgeschlagen",
  };
}

/**
 * Prueft ein lokales Dumpartefakt durch echten Restore in eine ausschliesslich
 * selbst erzeugte temporaere Sandbox-Datenbank.
 *
 * Reihenfolge: Options-/Artefakt-/Verbindungspruefung, SHA-256- und
 * Byteanzahlpruefung, dann erst Datenbankanlage und pg_restore. In finally
 * werden alle Clients geschlossen und ausschliesslich die in diesem Aufruf
 * erfolgreich angelegte Zieldatenbank entfernt. Die Quelldatenbank und fremde
 * Datenbanken werden nie geloescht.
 */
export async function verifyRestore(
  options: VerifyRestoreOptions,
): Promise<VerifyRestoreResult> {
  const startedAt = new Date().toISOString();
  const result: VerifyRestoreResult = {
    success: false,
    artifactSha256: "",
    startedAt,
    restoreDurationMs: 0,
    verificationPassed: false,
    cleanupSucceeded: true,
  };

  if (!isRecord(options)) {
    result.error = {
      code: "invalid_options",
      message: "Es wurden keine gueltigen Restore-Optionen angegeben",
    };
    return result;
  }

  let maintenanceClient: Client | undefined;
  let verificationClient: Client | undefined;
  let targetCreated = false;
  let targetDatabaseName: string | undefined;
  let primaryError: RestoreError | undefined;
  let cleanupFailed = false;

  try {
    if (options.environment !== "test") {
      fail(
        "invalid_environment",
        "Restore-Nachweise sind ausschliesslich in der Umgebung test erlaubt",
      );
    }

    // Ein vom Aufrufer gelieferter Zieldatenbankname wird grundsaetzlich
    // abgewiesen; der Name wird ausschliesslich intern erzeugt.
    if ((options as unknown as Record<string, unknown>).targetDatabaseName !== undefined) {
      fail(
        "invalid_options",
        "Ein vom Aufrufer gelieferter Restore-Zieldatenbankname wird nicht akzeptiert",
      );
    }

    const artifact = await validateArtifact(options.artifact);
    result.artifactSha256 = artifact.sha256;

    const connection = await validateConnection(options.connection);
    const verifier = resolveVerifier(options.verifyContent);
    const timeoutMs = resolveTimeout(options.timeoutMs);
    const pgRestoreBinary = resolveBinary(options.pgRestoreBinary);

    if (options.signal?.aborted === true) {
      fail("aborted", "Der Restore wurde abgebrochen");
    }

    // Integritaetskontrolle vollstaendig vor jeder Datenbankoperation.
    await verifyArtifactIntegrity(artifact);

    maintenanceClient = new Client(clientConfig(connection));
    try {
      await maintenanceClient.connect();
    } catch {
      fail(
        "source_connection_failed",
        "Die lokale Quelldatenbank konnte nicht verbunden werden",
      );
    }

    targetDatabaseName = await createTargetDatabase(
      maintenanceClient,
      connection.database,
    );
    targetCreated = true;
    result.targetDatabaseName = targetDatabaseName;

    const targetConnection: LocalRestoreConnection = {
      ...connection,
      database: targetDatabaseName,
    };

    const restoreStarted = performance.now();
    try {
      await runPgRestore({
        binary: pgRestoreBinary,
        databaseName: targetDatabaseName,
        artifactPath: artifact.artifactPath,
        env: buildChildEnvironment(targetConnection),
        timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } finally {
      result.restoreDurationMs = Math.max(
        0,
        Math.round(performance.now() - restoreStarted),
      );
    }

    // Inhaltspruefung gegen einen separaten Zielclient.
    verificationClient = new Client(clientConfig(targetConnection));
    try {
      await verificationClient.connect();
    } catch {
      fail(
        "target_connection_failed",
        "Die restaurierte Zieldatenbank konnte nicht verbunden werden",
      );
    }

    let verified = false;
    try {
      verified = await verifier({
        client: verificationClient,
        targetDatabase: targetDatabaseName,
        connection: targetConnection,
      });
    } catch {
      fail(
        "verification_failed",
        "Die Inhaltspruefung des Restores ist fehlgeschlagen",
      );
    }

    result.verificationPassed = verified === true;
    if (!result.verificationPassed) {
      fail(
        "verification_failed",
        "Die Inhaltspruefung des Restores ist fehlgeschlagen",
      );
    }
  } catch (error) {
    primaryError = toRestoreError(error);
  } finally {
    if (verificationClient !== undefined) {
      try {
        await verificationClient.end();
      } catch {
        // Client-Schliessen ist best effort; der Drop entscheidet ueber den
        // Aufraeumerfolg.
      }
      verificationClient = undefined;
    }

    if (targetCreated && targetDatabaseName !== undefined) {
      if (maintenanceClient === undefined) {
        cleanupFailed = true;
      } else {
        try {
          await maintenanceClient.query(
            "drop database if exists " + quoteIdentifier(targetDatabaseName),
          );
        } catch {
          cleanupFailed = true;
        }
      }
    }

    if (maintenanceClient !== undefined) {
      try {
        await maintenanceClient.end();
      } catch {
        // Kein weiterer Handlungsbedarf; der Drop-Status ist bereits erfasst.
      }
      maintenanceClient = undefined;
    }
  }

  result.cleanupSucceeded = !cleanupFailed;

  if (primaryError !== undefined) {
    result.error = primaryError;
  } else if (cleanupFailed) {
    result.error = {
      code: "cleanup_failed",
      message: "Die selbst erzeugte Zieldatenbank konnte nicht entfernt werden",
    };
  }

  result.success =
    primaryError === undefined &&
    result.verificationPassed &&
    result.cleanupSucceeded;

  return result;
}
