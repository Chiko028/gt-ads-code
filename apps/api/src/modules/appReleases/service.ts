/**
 * CX-168: App-Updates fuer die Tablets.
 *
 * Der Dienst ist die einzige Speichergrenze fuer app_releases und
 * app_release_device_reports. Upload, Freigabe, Update-Kanal, Zielauswahl,
 * HMAC-Downloadticket und Rueckmeldung laufen ausschliesslich hier.
 *
 * Regeln:
 * - version_code ist streng steigend, version_name eindeutig; Verstoesse 409.
 * - Nur ein ZIP-Kopf (APK) wird angenommen, hoechstens 200 MB.
 * - Die Datei liegt unter <storageRoot>/app-releases/<id>.apk.
 * - Audit entsteht in derselben Transaktion wie die Fachaenderung.
 * - Ein Downloadticket bindet Tablet und Version fuer genau eine Stunde.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { AUDIT_ACTIONS, insertAuditEvent } from "../audit/repository.js";

/** Groesste angenommene APK-Datei. */
export const APP_RELEASE_MAX_BYTES = 200 * 1024 * 1024;
/** Groesste Laenge des Versionsnamens. */
export const APP_RELEASE_MAX_NAME_LENGTH = 64;
/** Groesste Laenge der Versionsnotizen. */
export const APP_RELEASE_MAX_NOTES_LENGTH = 500;
/** Gueltigkeit eines Downloadtickets in Sekunden (1 h). */
export const APP_RELEASE_TICKET_TTL_SECONDS = 3600;
/** Domainpraefix der HMAC-Nachricht. */
export const APP_RELEASE_TICKET_DOMAIN = "gt-ads-app-download-v1";
/** Mindestlaenge des HMAC-Geheimnisses. */
export const APP_RELEASE_MIN_SECRET_BYTES = 32;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const LOWER_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION_NAME_PATTERN = /^[A-Za-z0-9._+() -]{1,64}$/;
const DETAIL_PATTERN = /^[a-z0-9_]{1,64}$/;

export type AppReleaseRollout = "none" | "pilot" | "all";
export type AppUpdateChannel = "stable" | "pilot";
export type AppReportStatus = "downloaded" | "installed" | "failed";

const ROLLOUTS: ReadonlySet<string> = new Set(["none", "pilot", "all"]);
const CHANNELS: ReadonlySet<string> = new Set(["stable", "pilot"]);
const REPORT_STATUSES: ReadonlySet<string> = new Set([
  "downloaded",
  "installed",
  "failed",
]);

export class AppReleaseValidationError extends Error {
  constructor(message = "App-Version ist ungueltig.") {
    super(message);
    this.name = "AppReleaseValidationError";
  }
}

export class AppReleaseConflictError extends Error {
  constructor(message = "App-Version ist bereits vorhanden.") {
    super(message);
    this.name = "AppReleaseConflictError";
  }
}

export class AppReleaseNotFoundError extends Error {
  constructor(message = "App-Version nicht gefunden.") {
    super(message);
    this.name = "AppReleaseNotFoundError";
  }
}

export class AppReleaseStorageError extends Error {
  constructor(message = "App-Version konnte nicht gespeichert werden.", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AppReleaseStorageError";
  }
}

/** Oeffentliche Projektion einer App-Version. */
export interface AppRelease {
  readonly id: string;
  readonly version_code: number;
  readonly version_name: string;
  readonly notes: string | null;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly rollout: AppReleaseRollout;
  readonly created_at: string;
  readonly created_by: string;
  readonly rollout_changed_at: string | null;
}

export interface AppReleaseOverview {
  readonly releases: Array<
    AppRelease & {
      readonly downloaded: number;
      readonly installed: number;
      readonly failed: number;
    }
  >;
  readonly devices: Array<{
    readonly device_id: string;
    readonly label: string | null;
    readonly taxi_id: string | null;
    readonly taxi_name: string | null;
    readonly update_channel: AppUpdateChannel;
    readonly app_version: string;
    readonly os_version: string;
    readonly state: "active" | "revoked";
    readonly last_report: {
      readonly release_id: string;
      readonly version_code: number;
      readonly version_name: string;
      readonly status: AppReportStatus;
      readonly detail: string | null;
      readonly reported_at: string;
    } | null;
  }>;
}

export interface CreateAppReleaseInput {
  readonly versionCode: unknown;
  readonly versionName: unknown;
  readonly notes: unknown;
  readonly sha256: unknown;
  readonly content: Buffer;
  readonly actorId: string;
}

export interface AppDownloadTicketPayload {
  readonly schemaVersion: 1;
  readonly deviceId: string;
  readonly releaseId: string;
  readonly versionCode: number;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly expiresAt: number;
}

export interface AppDownloadResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly bytes: Uint8Array;
}

interface ReleaseRow extends Record<string, unknown> {
  id: string;
  version_code: number;
  version_name: string;
  notes: string | null;
  sha256: string;
  size_bytes: string | number;
  rollout: string;
  created_at: Date | string;
  created_by: string;
  rollout_changed_at: Date | string | null;
}

interface DeviceRow extends Record<string, unknown> {
  id: string;
  state: string;
  update_channel: string;
}

interface CountRow extends Record<string, unknown> {
  release_id: string;
  downloaded: number;
  installed: number;
  failed: number;
}

interface OverviewDeviceRow extends Record<string, unknown> {
  device_id: string;
  label: string | null;
  taxi_id: string | null;
  taxi_name: string | null;
  update_channel: string;
  app_version: string;
  os_version: string;
  state: string;
  last_release_id: string | null;
  last_version_code: number | null;
  last_version_name: string | null;
  last_status: string | null;
  last_detail: string | null;
  last_reported_at: Date | string | null;
}

export interface AppReleaseServiceOptions {
  readonly pool: Pool;
  readonly storageRoot: string;
  readonly downloadSecret?: string | null;
  readonly now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function parseRollout(value: unknown): AppReleaseRollout {
  if (typeof value !== "string" || !ROLLOUTS.has(value)) {
    throw new AppReleaseValidationError();
  }
  return value as AppReleaseRollout;
}

function parseChannel(value: unknown): AppUpdateChannel {
  if (typeof value !== "string" || !CHANNELS.has(value)) {
    throw new AppReleaseValidationError();
  }
  return value as AppUpdateChannel;
}

function parseUuid(value: unknown): string {
  if (typeof value !== "string" || !LOWER_UUID_PATTERN.test(value)) {
    throw new AppReleaseValidationError();
  }
  return value;
}

function parseVersionCode(value: unknown): number {
  let parsed: number;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    parsed = value;
  } else if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    parsed = Number(value);
  } else {
    throw new AppReleaseValidationError();
  }
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new AppReleaseValidationError();
  }
  return parsed;
}

function parseVersionName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > APP_RELEASE_MAX_NAME_LENGTH ||
    !VERSION_NAME_PATTERN.test(value)
  ) {
    throw new AppReleaseValidationError();
  }
  return value;
}

function parseNotes(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || value.length > APP_RELEASE_MAX_NOTES_LENGTH) {
    throw new AppReleaseValidationError();
  }
  return value;
}

function parseSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new AppReleaseValidationError();
  }
  return value;
}

/** APK ist ein ZIP; akzeptiert werden die ueblichen ZIP-Kopfvarianten. */
function isZipHeader(content: Buffer): boolean {
  if (content.length < 4) {
    return false;
  }
  if (content[0] !== 0x50 || content[1] !== 0x4b) {
    return false;
  }
  const third = content[2];
  const fourth = content[3];
  return (
    (third === 0x03 && fourth === 0x04) ||
    (third === 0x05 && fourth === 0x06) ||
    (third === 0x07 && fourth === 0x08)
  );
}

function toRelease(row: ReleaseRow): AppRelease {
  return {
    id: row.id,
    version_code: Number(row.version_code),
    version_name: row.version_name,
    notes: row.notes,
    sha256: row.sha256,
    size_bytes: Number(row.size_bytes),
    rollout: row.rollout as AppReleaseRollout,
    created_at: iso(row.created_at),
    created_by: row.created_by,
    rollout_changed_at: isoOrNull(row.rollout_changed_at),
  };
}

function offered(rollout: AppReleaseRollout, channel: AppUpdateChannel): boolean {
  if (rollout === "all") {
    return true;
  }
  return rollout === "pilot" && channel === "pilot";
}

function releasePath(storageRoot: string, releaseId: string): string {
  return join(storageRoot, "app-releases", releaseId + ".apk");
}

function serializeTicket(payload: AppDownloadTicketPayload): string {
  return (
    '{"schemaVersion":1' +
    ',"deviceId":' + JSON.stringify(payload.deviceId) +
    ',"releaseId":' + JSON.stringify(payload.releaseId) +
    ',"versionCode":' + String(payload.versionCode) +
    ',"sha256":' + JSON.stringify(payload.sha256) +
    ',"sizeBytes":' + String(payload.sizeBytes) +
    ',"expiresAt":' + String(payload.expiresAt) +
    "}"
  );
}

export function issueAppDownloadTicket(input: {
  readonly deviceId: string;
  readonly release: AppRelease;
  readonly secret: string;
  readonly now: Date;
}): { ticket: string; query: string; payload: AppDownloadTicketPayload } {
  const payload: AppDownloadTicketPayload = {
    schemaVersion: 1,
    deviceId: input.deviceId,
    releaseId: input.release.id,
    versionCode: input.release.version_code,
    sha256: input.release.sha256,
    sizeBytes: input.release.size_bytes,
    expiresAt: Math.floor(input.now.getTime() / 1000) + APP_RELEASE_TICKET_TTL_SECONDS,
  };
  const encoded = Buffer.from(serializeTicket(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", input.secret)
    .update(APP_RELEASE_TICKET_DOMAIN + "\n" + encoded, "utf8")
    .digest("base64url");
  const ticket = encoded + "." + mac;
  return { ticket, query: "ticket=" + encodeURIComponent(ticket), payload };
}

export function verifyAppDownloadTicket(input: {
  readonly ticket: string;
  readonly secret: string;
  readonly now: Date;
}): AppDownloadTicketPayload | null {
  const parts = input.ticket.split(".");
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    return null;
  }
  const expected = createHmac("sha256", input.secret)
    .update(APP_RELEASE_TICKET_DOMAIN + "\n" + parts[0], "utf8")
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(parts[1], "base64url");
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }
  const payloadText = Buffer.from(parts[0], "base64url").toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const keys = Object.keys(parsed);
  const expectedKeys = [
    "schemaVersion",
    "deviceId",
    "releaseId",
    "versionCode",
    "sha256",
    "sizeBytes",
    "expiresAt",
  ];
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key, index) => keys[index] !== key)
  ) {
    return null;
  }
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.deviceId !== "string" ||
    !LOWER_UUID_PATTERN.test(parsed.deviceId) ||
    typeof parsed.releaseId !== "string" ||
    !LOWER_UUID_PATTERN.test(parsed.releaseId) ||
    typeof parsed.versionCode !== "number" ||
    !Number.isSafeInteger(parsed.versionCode) ||
    parsed.versionCode <= 0 ||
    typeof parsed.sha256 !== "string" ||
    !SHA256_PATTERN.test(parsed.sha256) ||
    typeof parsed.sizeBytes !== "number" ||
    !Number.isSafeInteger(parsed.sizeBytes) ||
    parsed.sizeBytes <= 0 ||
    typeof parsed.expiresAt !== "number" ||
    !Number.isSafeInteger(parsed.expiresAt) ||
    parsed.expiresAt <= 0
  ) {
    return null;
  }
  const payload = parsed as unknown as AppDownloadTicketPayload;
  if (serializeTicket(payload) !== payloadText) {
    return null;
  }
  if (Math.floor(input.now.getTime() / 1000) >= payload.expiresAt) {
    return null;
  }
  return payload;
}

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

function parseRange(
  header: string,
  size: number,
): { kind: "none" } | { kind: "range"; range: ByteRange } | { kind: "invalid" } | { kind: "unsatisfiable" } {
  const trimmed = header.trim();
  const match = /^bytes=(.*)$/i.exec(trimmed);
  if (match === null || trimmed.length === 0) {
    return { kind: "invalid" };
  }
  const spec = (match[1] as string).trim();
  if (spec.includes(",") || !/^[0-9]*-[0-9]*$/.test(spec)) {
    return { kind: "invalid" };
  }
  const dash = spec.indexOf("-");
  const left = spec.slice(0, dash);
  const right = spec.slice(dash + 1);
  if (left.length === 0 && right.length === 0) {
    return { kind: "invalid" };
  }
  if (left.length === 0) {
    const suffix = Number(right);
    if (!Number.isSafeInteger(suffix)) {
      return { kind: "invalid" };
    }
    if (suffix <= 0 || size === 0) {
      return { kind: "unsatisfiable" };
    }
    return { kind: "range", range: { start: Math.max(size - suffix, 0), end: size - 1 } };
  }
  const start = Number(left);
  if (!Number.isSafeInteger(start)) {
    return { kind: "invalid" };
  }
  if (right.length === 0) {
    if (start >= size) {
      return { kind: "unsatisfiable" };
    }
    return { kind: "range", range: { start, end: size - 1 } };
  }
  const end = Number(right);
  if (!Number.isSafeInteger(end) || end < start) {
    return { kind: "invalid" };
  }
  if (start >= size) {
    return { kind: "unsatisfiable" };
  }
  return { kind: "range", range: { start, end: Math.min(end, size - 1) } };
}

function reject(status: number, headers: Record<string, string> = {}): AppDownloadResult {
  return { status, headers, bytes: new Uint8Array(0) };
}

export class AppReleaseService {
  private readonly pool: Pool;
  private readonly storageRoot: string;
  private readonly downloadSecret: string | null;
  private readonly now: () => Date;

  constructor(options: AppReleaseServiceOptions) {
    this.pool = options.pool;
    this.storageRoot = options.storageRoot;
    this.downloadSecret = options.downloadSecret ?? null;
    this.now = options.now ?? (() => new Date());
  }

  private async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw new AppReleaseStorageError(undefined, { cause: error });
    }
    let inTransaction = false;
    try {
      await client.query("begin");
      inTransaction = true;
      const result = await work(client);
      await client.query("commit");
      inTransaction = false;
      return result;
    } catch (error) {
      if (inTransaction) {
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

  async create(input: CreateAppReleaseInput): Promise<AppRelease> {
    if (!Buffer.isBuffer(input.content)) {
      throw new AppReleaseValidationError();
    }
    const versionCode = parseVersionCode(input.versionCode);
    const versionName = parseVersionName(input.versionName);
    const notes = parseNotes(input.notes);
    const sha256 = parseSha256(input.sha256);
    const content = input.content;
    if (content.length <= 0 || content.length > APP_RELEASE_MAX_BYTES) {
      throw new AppReleaseValidationError();
    }
    if (!isZipHeader(content)) {
      throw new AppReleaseValidationError();
    }
    const computed = createHash("sha256").update(content).digest("hex");
    if (computed !== sha256) {
      throw new AppReleaseValidationError();
    }

    const id = randomUUID();
    const createdAt = this.now();
    const path = releasePath(this.storageRoot, id);

    try {
      return await this.withTransaction(async (client) => {
        const existing = await client.query<{ max_code: number }>(
          "select coalesce(max(version_code), 0)::int as max_code from app_releases",
        );
        if (versionCode <= (existing.rows[0]?.max_code ?? 0)) {
          throw new AppReleaseConflictError();
        }
        const name = await client.query(
          "select 1 from app_releases where version_name = $1",
          [versionName],
        );
        if (name.rows.length > 0) {
          throw new AppReleaseConflictError();
        }

        const inserted = await client.query<ReleaseRow>(
          [
            "insert into app_releases",
            "  (id, version_code, version_name, notes, sha256, size_bytes,",
            "   rollout, created_at, created_by)",
            "values ($1::uuid, $2, $3, $4, $5, $6, 'none', $7, $8)",
            "returning id::text as id, version_code, version_name, notes, sha256,",
            "          size_bytes, rollout, created_at, created_by,",
            "          rollout_changed_at",
          ].join("\n"),
          [
            id,
            versionCode,
            versionName,
            notes,
            sha256,
            content.length,
            createdAt,
            input.actorId,
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined) {
          throw new AppReleaseStorageError();
        }

        await mkdir(join(this.storageRoot, "app-releases"), { recursive: true });
        await writeFile(path, content);

        await insertAuditEvent(client, {
          at: createdAt,
          actorType: "admin",
          actorId: input.actorId,
          action: AUDIT_ACTIONS.appReleaseCreated,
          targetType: "app_release",
          targetId: id,
          details: {
            version_code: versionCode,
            version_name: versionName,
            size_bytes: content.length,
            rollout: "none",
          },
        });

        return toRelease(row);
      });
    } catch (error) {
      await unlink(path).catch(() => undefined);
      if (
        error instanceof AppReleaseValidationError ||
        error instanceof AppReleaseConflictError
      ) {
        throw error;
      }
      if (
        isRecord(error) &&
        (error as { code?: unknown }).code === "23505"
      ) {
        throw new AppReleaseConflictError();
      }
      throw new AppReleaseStorageError(undefined, { cause: error });
    }
  }

  async setRollout(
    releaseId: string,
    rollout: unknown,
    actorId: string,
  ): Promise<AppRelease> {
    const id = parseUuid(releaseId);
    const next = parseRollout(rollout);
    const at = this.now();
    return this.withTransaction(async (client) => {
      const current = await client.query<ReleaseRow>(
        "select id::text as id, version_code, version_name, notes, sha256," +
          " size_bytes, rollout, created_at, created_by, rollout_changed_at" +
          " from app_releases where id = $1::uuid for update",
        [id],
      );
      const row = current.rows[0];
      if (row === undefined) {
        throw new AppReleaseNotFoundError();
      }
      const updated = await client.query<ReleaseRow>(
        "update app_releases set rollout = $2, rollout_changed_at = $3" +
          " where id = $1::uuid" +
          " returning id::text as id, version_code, version_name, notes, sha256," +
          " size_bytes, rollout, created_at, created_by, rollout_changed_at",
        [id, next, at],
      );
      const result = updated.rows[0];
      if (result === undefined) {
        throw new AppReleaseStorageError();
      }
      await insertAuditEvent(client, {
        at,
        actorType: "admin",
        actorId,
        action: AUDIT_ACTIONS.appReleaseRolloutChanged,
        targetType: "app_release",
        targetId: id,
        details: {
          rollout: next,
          previous_rollout: row.rollout,
          version_code: Number(row.version_code),
        },
      });
      return toRelease(result);
    });
  }

  async setUpdateChannel(
    deviceId: string,
    channel: unknown,
    actorId: string,
  ): Promise<{ device_id: string; update_channel: AppUpdateChannel }> {
    const id = parseUuid(deviceId);
    const next = parseChannel(channel);
    const at = this.now();
    return this.withTransaction(async (client) => {
      const current = await client.query<DeviceRow>(
        "select id::text as id, state, update_channel from devices" +
          " where id = $1::uuid for update",
        [id],
      );
      const row = current.rows[0];
      if (row === undefined) {
        throw new AppReleaseNotFoundError();
      }
      await client.query(
        "update devices set update_channel = $2 where id = $1::uuid",
        [id, next],
      );
      await insertAuditEvent(client, {
        at,
        actorType: "admin",
        actorId,
        action: AUDIT_ACTIONS.deviceUpdateChannelChanged,
        targetType: "device",
        targetId: id,
        details: {
          update_channel: next,
          previous_update_channel: row.update_channel,
        },
      });
      return { device_id: id, update_channel: next };
    });
  }

  async overview(): Promise<AppReleaseOverview> {
    const releases = await this.pool.query<ReleaseRow>(
      "select id::text as id, version_code, version_name, notes, sha256," +
        " size_bytes, rollout, created_at, created_by, rollout_changed_at" +
        " from app_releases order by version_code desc",
    );
    const counts = await this.pool.query<CountRow>(
      [
        "select release_id::text as release_id,",
        "       (count(*) filter (where status = 'downloaded'))::int as downloaded,",
        "       (count(*) filter (where status = 'installed'))::int as installed,",
        "       (count(*) filter (where status = 'failed'))::int as failed",
        "  from app_release_device_reports",
        " group by release_id",
      ].join("\n"),
    );
    const byRelease = new Map<string, CountRow>();
    for (const row of counts.rows) {
      byRelease.set(row.release_id.toLowerCase(), row);
    }

    const devices = await this.pool.query<OverviewDeviceRow>(
      [
        "select d.id::text as device_id, d.label, d.update_channel,",
        "       d.app_version, d.os_version, d.state,",
        "       a.taxi_id, t.display_name as taxi_name,",
        "       lr.release_id as last_release_id,",
        "       lr.version_code as last_version_code,",
        "       lr.version_name as last_version_name,",
        "       lr.status as last_status, lr.detail as last_detail,",
        "       lr.reported_at as last_reported_at",
        "  from devices d",
        "  left join lateral (",
        "    select taxi_id from device_taxi_assignments",
        "     where device_id = d.id and active = true",
        "     order by updated_at desc, taxi_id asc limit 1",
        "  ) a on true",
        "  left join taxis t on t.id = a.taxi_id",
        "  left join lateral (",
        "    select f.release_id::text as release_id, f.status, f.detail,",
        "           f.reported_at, r.version_code, r.version_name",
        "      from app_release_device_reports f",
        "      join app_releases r on r.id = f.release_id",
        "     where f.device_id = d.id",
        "     order by f.reported_at desc, r.version_code desc limit 1",
        "  ) lr on true",
        " order by d.id",
      ].join("\n"),
    );

    return {
      releases: releases.rows.map((row) => {
        const count = byRelease.get(row.id.toLowerCase());
        return {
          ...toRelease(row),
          downloaded: count?.downloaded ?? 0,
          installed: count?.installed ?? 0,
          failed: count?.failed ?? 0,
        };
      }),
      devices: devices.rows.map((row) => ({
        device_id: row.device_id,
        label: row.label,
        taxi_id: row.taxi_id,
        taxi_name: row.taxi_name,
        update_channel: row.update_channel as AppUpdateChannel,
        app_version: row.app_version,
        os_version: row.os_version,
        state: row.state === "revoked" ? "revoked" : "active",
        last_report:
          row.last_release_id === null ||
          row.last_status === null ||
          row.last_version_code === null ||
          row.last_version_name === null ||
          row.last_reported_at === null
            ? null
            : {
                release_id: row.last_release_id,
                version_code: Number(row.last_version_code),
                version_name: row.last_version_name,
                status: row.last_status as AppReportStatus,
                detail: row.last_detail,
                reported_at: iso(row.last_reported_at),
              },
      })),
    };
  }

  /** Hoechste fuer den Update-Kanal des Tablets freigegebene Version. */
  async targetFor(deviceId: string): Promise<{ release: AppRelease; channel: AppUpdateChannel } | null> {
    if (this.downloadSecret === null) {
      return null;
    }
    const id = parseUuid(deviceId);
    const device = await this.pool.query<DeviceRow>(
      "select id::text as id, state, update_channel from devices" +
        " where id = $1::uuid and state = 'active'",
      [id],
    );
    const row = device.rows[0];
    if (row === undefined) {
      return null;
    }
    const channel = row.update_channel as AppUpdateChannel;
    const result = await this.pool.query<ReleaseRow>(
      "select id::text as id, version_code, version_name, notes, sha256," +
        " size_bytes, rollout, created_at, created_by, rollout_changed_at" +
        " from app_releases" +
        " where rollout = 'all' or (rollout = 'pilot' and $1 = 'pilot')" +
        " order by version_code desc limit 1",
      [channel],
    );
    const release = result.rows[0];
    return release === undefined ? null : { release: toRelease(release), channel };
  }

  async download(input: {
    readonly releaseId: string;
    readonly ticket: string;
    readonly deviceId: string;
    readonly rangeHeader: string | null;
    readonly ifRangeHeader: string | null;
  }): Promise<AppDownloadResult> {
    const secret = this.downloadSecret;
    if (secret === null) {
      return reject(403);
    }
    let releaseId: string;
    try {
      releaseId = parseUuid(input.releaseId);
    } catch {
      return reject(404);
    }
    const payload = verifyAppDownloadTicket({
      ticket: input.ticket,
      secret,
      now: this.now(),
    });
    if (payload === null) {
      return reject(403);
    }
    if (payload.deviceId !== input.deviceId) {
      return reject(403);
    }
    if (payload.releaseId !== releaseId) {
      return reject(403);
    }

    const device = await this.pool.query<DeviceRow>(
      "select id::text as id, state, update_channel from devices" +
        " where id = $1::uuid",
      [input.deviceId],
    );
    const deviceRow = device.rows[0];
    if (deviceRow === undefined || deviceRow.state !== "active") {
      return reject(404);
    }
    const channel = deviceRow.update_channel as AppUpdateChannel;

    const releaseResult = await this.pool.query<ReleaseRow>(
      "select id::text as id, version_code, version_name, notes, sha256," +
        " size_bytes, rollout, created_at, created_by, rollout_changed_at" +
        " from app_releases where id = $1::uuid",
      [releaseId],
    );
    const releaseRow = releaseResult.rows[0];
    if (releaseRow === undefined) {
      return reject(404);
    }
    const release = toRelease(releaseRow);
    if (!offered(release.rollout, channel)) {
      return reject(404);
    }
    if (
      payload.versionCode !== release.version_code ||
      payload.sha256 !== release.sha256 ||
      payload.sizeBytes !== release.size_bytes
    ) {
      return reject(403);
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(releasePath(this.storageRoot, release.id));
    } catch {
      return reject(404);
    }
    if (bytes.length !== release.size_bytes) {
      return reject(404);
    }

    const etag = '"' + release.sha256 + '"';
    const rangeHeader = input.rangeHeader;
    if (rangeHeader === null || rangeHeader.trim().length === 0) {
      return {
        status: 200,
        headers: {
          ETag: etag,
          "Accept-Ranges": "bytes",
          "Content-Length": String(release.size_bytes),
        },
        bytes: new Uint8Array(bytes),
      };
    }
    const ifRange = input.ifRangeHeader?.trim();
    if (ifRange !== undefined && ifRange !== etag) {
      return {
        status: 200,
        headers: {
          ETag: etag,
          "Accept-Ranges": "bytes",
          "Content-Length": String(release.size_bytes),
        },
        bytes: new Uint8Array(bytes),
      };
    }
    const parsed = parseRange(rangeHeader, release.size_bytes);
    if (parsed.kind === "invalid") {
      return reject(400);
    }
    if (parsed.kind === "unsatisfiable") {
      return reject(416, {
        "Content-Range": "bytes */" + String(release.size_bytes),
        "Content-Length": "0",
      });
    }
    if (parsed.kind === "none") {
      return {
        status: 200,
        headers: {
          ETag: etag,
          "Accept-Ranges": "bytes",
          "Content-Length": String(release.size_bytes),
        },
        bytes: new Uint8Array(bytes),
      };
    }
    const range = parsed.range;
    const length = range.end - range.start + 1;
    return {
      status: 206,
      headers: {
        ETag: etag,
        "Accept-Ranges": "bytes",
        "Content-Length": String(length),
        "Content-Range":
          "bytes " + String(range.start) + "-" + String(range.end) +
          "/" + String(release.size_bytes),
      },
      bytes: new Uint8Array(bytes.subarray(range.start, range.end + 1)),
    };
  }

  async report(deviceId: string, body: unknown): Promise<void> {
    if (!isRecord(body)) {
      throw new AppReleaseValidationError();
    }
    const allowed = new Set(["release_id", "status", "detail"]);
    for (const key of Object.keys(body)) {
      if (!allowed.has(key)) {
        throw new AppReleaseValidationError();
      }
    }
    const releaseId = parseUuid(body.release_id);
    const status = body.status;
    if (typeof status !== "string" || !REPORT_STATUSES.has(status)) {
      throw new AppReleaseValidationError();
    }
    const detail = body.detail;
    if (
      detail !== undefined &&
      detail !== null &&
      (typeof detail !== "string" || !DETAIL_PATTERN.test(detail))
    ) {
      throw new AppReleaseValidationError();
    }
    const device = parseUuid(deviceId);

    const exists = await this.pool.query(
      "select 1 from app_releases where id = $1::uuid",
      [releaseId],
    );
    if (exists.rows.length === 0) {
      throw new AppReleaseNotFoundError();
    }
    const reportedAt = this.now();
    await this.pool.query(
      [
        "insert into app_release_device_reports",
        "  (device_id, release_id, status, detail, reported_at)",
        "values ($1::uuid, $2::uuid, $3, $4, $5)",
        "on conflict (device_id, release_id) do update",
        "   set status = excluded.status,",
        "       detail = excluded.detail,",
        "       reported_at = excluded.reported_at",
      ].join("\n"),
      [device, releaseId, status, detail ?? null, reportedAt],
    );
  }
}

export function createAppReleaseService(
  options: AppReleaseServiceOptions,
): AppReleaseService {
  return new AppReleaseService(options);
}
