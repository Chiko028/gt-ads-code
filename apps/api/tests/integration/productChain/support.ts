/**
 * CX-063 / R-801: lokale Hilfsmittel des Produktkettentests.
 *
 * Es gibt keine Mocks fuer Fachhandler, Repositorys, Signaturen,
 * Geraeteauthentifizierung oder Manifest-Erzeugung. Die Hilfsmittel bauen
 * ausschliesslich die echte zentrale Fastify-App, echte Migrationen, eine
 * laufbezogene PostgreSQL-Datenbank und einen temporaeren Medienspeicher auf.
 * Alle Kettenobjekte werden, soweit die vorhandene API reicht, ueber die
 * echten HTTP-Routen erzeugt.
 */
import {
  generateKeyPairSync,
  randomUUID,
  sign as signWithKey,
  type KeyObject,
} from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { CONFIG_DEFAULTS, type AppConfig } from "../../../src/config.js";
import { buildSignatureMessage } from "../../../src/crypto/deviceSignature.js";
import { hashPassword } from "../../../src/crypto/password.js";
import { createServer } from "../../../src/http/server.js";
import { createDeviceAuthMiddleware } from "../../../src/modules/deviceAuth/middleware.js";
import { createMedia } from "../../../src/modules/media/index.js";
import { ADMIN_SESSION_COOKIE } from "../../../src/modules/adminAuth/middleware.js";
import { ensureCampaignSchema } from "../../../src/modules/campaigns/schema.js";
import { ManifestRefreshService } from "../../../src/modules/manifestRefresh/index.js";
import {
  issueDownloadTicket,
  processDownloadRequest,
  type DownloadAuthorizationAdapter,
  type DownloadMediaSource,
} from "../../../src/modules/playout/download.js";
import {
  verifySignedManifest,
  type SignedManifestEnvelope,
  type VerifiedManifest,
} from "../../../src/modules/playout/manifest.js";
import { REMOTE_CONTROL_AUDIT_ACTION } from "../../../src/modules/remoteControl/index.js";
import { ensureTaxiActivationSchema } from "../../../src/modules/taxiActivation/index.js";
import { ensureTabletActivationSchema } from "../../../src/modules/tabletActivation/index.js";
import {
  ADMIN_PASSWORD,
  BASE_TIME,
  DEVICE_INFO,
  DOWNLOAD_SECRET,
  HOST,
  MEDIA_DURATION_SECONDS,
  ORIGIN,
  syntheticEvents,
  type SyntheticEvent,
} from "./fixtures.js";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/db/migrations",
);

/**
 * Vollstaendiger, tatsaechlich vorhandener Migrationssatz. Die Reihenfolge ist
 * die der Dateinamen; jede Datei wird genau einmal ausgefuehrt.
 */
const MIGRATION_FILES = [
  "0001_gt_ads_001.up.sql",
  "0002_gt_ads_004_telemetry.up.sql",
  "0003_cx_011_telemetry_rollups.up.sql",
  "0004_cx_012_remote_control.up.sql",
  "0005_cx_013_control_config.up.sql",
  "0006_cx_028_technical_alarms.up.sql",
  "0007_cx_030_media.up.sql",
  "0008_cx_065_admin_mfa_recovery_codes.up.sql",
  "0009_campaign_customers.up.sql",
  "0010_cx_041_manifest_refresh.up.sql",
  "0011_cx_078_media_deletion.up.sql",
  "0012_cx_101_campaign_drafts.up.sql",
  "0013_cx_106_pending_totp_enrollment.up.sql",
  "0014_cx_128_device_inventory.up.sql",
  "0015_cx_057_operators.up.sql",
] as const;

export interface ResponseLike {
  statusCode: number;
  body: string;
  rawPayload?: Buffer;
  headers: Record<string, unknown>;
  json(): any;
}

export interface RunDatabase {
  maintenancePool: Pool;
  pool: Pool;
  name: string;
  close(): Promise<void>;
}

export interface MutableClock {
  nowMs: number;
  now: () => Date;
  advance: (milliseconds: number) => void;
}

export function createClock(): MutableClock {
  let nowMs = BASE_TIME;
  return {
    get nowMs() {
      return nowMs;
    },
    set nowMs(value: number) {
      nowMs = value;
    },
    now: () => new Date(nowMs),
    advance: (milliseconds: number) => {
      nowMs += milliseconds;
    },
  };
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
    throw new Error("CX-063 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

/** Legt eine eigene Datenbank an und spielt alle echten Migrationen ein. */
export async function openRunDatabase(): Promise<RunDatabase> {
  const base = baseConnection();
  const maintenancePool = new Pool(base);
  const name = (
    "gtads_cx063_" +
    process.pid +
    "_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 8)
  )
    .toLowerCase()
    .slice(0, 63);

  await maintenancePool.query("create database " + quoteIdentifier(name));
  const pool = new Pool({ ...base, database: name });

  try {
    for (const file of MIGRATION_FILES) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await pool.query(sql);
    }
    // Additive Schemata, die die vorhandenen Dienste idempotent bereitstellen.
    await ensureTaxiActivationSchema(pool);
    await ensureTabletActivationSchema(pool);
    await ensureCampaignSchema(pool);
  } catch (error) {
    await pool.end().catch(() => undefined);
    await maintenancePool
      .query("drop database if exists " + quoteIdentifier(name))
      .catch(() => undefined);
    await maintenancePool.end().catch(() => undefined);
    throw error;
  }

  return {
    maintenancePool,
    pool,
    name,
    async close(): Promise<void> {
      await pool.end().catch(() => undefined);
      await maintenancePool
        .query(
          "select pg_terminate_backend(pid) from pg_stat_activity" +
            " where datname = $1 and pid <> pg_backend_pid()",
          [name],
        )
        .catch(() => undefined);
      await maintenancePool
        .query("drop database if exists " + quoteIdentifier(name))
        .catch(() => undefined);
      await maintenancePool.end().catch(() => undefined);
    },
  };
}

export async function createTestConfig(): Promise<AppConfig> {
  return {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    fallbackMediaId: null,
    registrationCodePepper: "SYN-CX063-Code-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}

export async function createRunStorageRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "gtads-cx063-media-"));
}

export async function buildApp(
  config: AppConfig,
  pool: Pool,
  clock: MutableClock,
  storageRoot: string,
): Promise<FastifyInstance> {
  const app = createServer({
    config,
    pool,
    now: clock.now,
    logger: { level: "silent" },
    // Technische Testkomposition fuer den fehlenden serverseitigen
    // Medienmetadatenleser: der echte CX-030-Service bleibt vollstaendig
    // zustaendig; nur die Profilmetadaten des synthetischen MP4 werden
    // explizit uebergeben.
    mediaUpload: {
      serviceOptions: { pool, storageRoot },
      createMedia: (options, input) =>
        createMedia(options, {
          ...input,
          metadata: {
            container: "mp4",
            videoCodec: "h264",
            width: 1920,
            height: 1080,
            frameRateNumerator: 30,
            frameRateDenominator: 1,
            audioStreamCount: 0,
            durationSeconds: MEDIA_DURATION_SECONDS,
          },
        }),
    },
  });

  // CX-008 stellt den signierten Download nur als transportneutralen Dienst
  // bereit; die produktive HTTP-Route fehlt im Integrationsstand. Dieser
  // lokale Transportadapter ruft ausschliesslich den echten Dienst, die echte
  // Geraeteauthentifizierung und echte Datenbank-/Dateizugriffe auf.
  registerDownloadTransport(app, pool, clock, storageRoot);

  await app.ready();
  return app;
}

/**
 * Testtransport fuer die im Integrationsstand fehlende CX-008-HTTP-Route.
 * Der Handler, die Signaturpruefung und die Geraeteauthentifizierung sind
 * unveraendert echt; nur der HTTP-Rahmen wird hier lokal bereitgestellt.
 */
function registerDownloadTransport(
  app: FastifyInstance,
  pool: Pool,
  clock: MutableClock,
  storageRoot: string,
): void {
  const authorization: DownloadAuthorizationAdapter = {
    async authorize(input) {
      const assignment = await pool.query(
        "select 1 from device_taxi_assignments" +
          " where device_id = $1 and taxi_id = $2 and active = true",
        [input.deviceId, input.taxiId],
      );
      if (assignment.rowCount !== 1) {
        return false;
      }
      const artifact = await pool.query<{ payload_base64: string }>(
        [
          "select a.payload_base64",
          "  from taxi_manifest_state s",
          "  join taxi_manifest_artifacts a",
          "    on a.taxi_id = s.taxi_id and a.version = s.current_version",
          " where s.taxi_id = $1 and s.current_version = $2",
        ].join("\n"),
        [input.taxiId, input.manifestVersion],
      );
      const row = artifact.rows[0];
      if (row === undefined) {
        return false;
      }
      try {
        const payload = JSON.parse(
          Buffer.from(row.payload_base64, "base64").toString("utf8"),
        ) as { entries?: Array<{ mediaId?: unknown; sha256?: unknown }> };
        return (
          Array.isArray(payload.entries) &&
          payload.entries.some(
            (entry) =>
              entry.mediaId === input.mediaId &&
              entry.sha256 === input.sha256,
          )
        );
      } catch {
        return false;
      }
    },
  };

  const mediaSource: DownloadMediaSource = {
    async read(mediaId) {
      const rows = await pool.query<{
        sha256: string;
        size_bytes: string;
      }>(
        "select sha256, size_bytes::text as size_bytes" +
          " from media_objects where id = $1 and status = 'ready'",
        [mediaId],
      );
      const row = rows.rows[0];
      if (row === undefined) {
        return null;
      }
      try {
        const content = await readFile(join(storageRoot, "objects", mediaId));
        return {
          sha256: row.sha256,
          sizeBytes: Number(row.size_bytes),
          content,
        };
      } catch {
        return null;
      }
    },
  };

  app.get(
    "/v1/device/downloads/:id",
    { preHandler: createDeviceAuthMiddleware(app.deviceAuthService) },
    async (request, reply) => {
      const context = request.deviceAuth;
      if (context === undefined) {
        return reply.code(401).send({ error: { code: "unauthorized" } });
      }
      const query = request.query as { ticket?: unknown };
      if (typeof query.ticket !== "string") {
        return reply.code(400).send({ error: { code: "invalid_request" } });
      }
      const range = request.headers.range;
      const ifRange = request.headers["if-range"];
      const result = await processDownloadRequest({
        ticket: query.ticket,
        deviceId: context.deviceId,
        secret: DOWNLOAD_SECRET,
        clock: clock.now,
        authorization,
        mediaSource,
        rangeHeader: typeof range === "string" ? range : null,
        ifRangeHeader: typeof ifRange === "string" ? ifRange : null,
      });
      reply.code(result.status);
      for (const [name, value] of Object.entries(result.headers)) {
        reply.header(name, value);
      }
      return reply.send(Buffer.from(result.bytes));
    },
  );
}

export function requireStatus(
  response: ResponseLike,
  expected: number,
  label: string,
): void {
  if (response.statusCode === expected) {
    return;
  }
  const body =
    response.body.length > 800
      ? response.body.slice(0, 800) + "..."
      : response.body;
  throw new Error(
    "CX-063: " +
      label +
      ": erwartet HTTP " +
      expected +
      ", erhalten " +
      response.statusCode +
      ". Antwort: " +
      body,
  );
}


export function responseJson<T>(response: ResponseLike): T {
  return response.json() as T;
}

export interface AdminSession {
  cookie: string;
  headers: Record<string, string>;
}

function sessionCookieOf(response: ResponseLike): string {
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw)
    ? (raw[0] as string)
    : (raw as string | undefined);
  if (typeof first !== "string" || first.length === 0) {
    throw new Error("CX-063: Admin-Login lieferte kein Set-Cookie.");
  }
  return first.split(";")[0]!.slice(ADMIN_SESSION_COOKIE.length + 1);
}

export function adminHeaders(
  session: AdminSession,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    host: HOST,
    "content-type": "application/json",
    origin: ORIGIN,
    cookie: ADMIN_SESSION_COOKIE + "=" + session.cookie,
    ...extra,
  };
}

export async function loginAdmin(
  app: FastifyInstance,
  password = ADMIN_PASSWORD,
): Promise<AdminSession> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, "content-type": "application/json" },
    payload: { password },
    remoteAddress: "192.0.2.200",
  });
  requireStatus(response, 204, "Admin-Anmeldung");
  const cookie = sessionCookieOf(response);
  return {
    cookie,
    headers: {
      host: HOST,
      "content-type": "application/json",
      origin: ORIGIN,
      cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
    },
  };
}

export interface ChainResources {
  deviceIds: string[];
  taxiIds: string[];
  campaignIds: string[];
  customerIds: string[];
  mediaIds: string[];
  registrationCodeIds: string[];
}

export function createResources(): ChainResources {
  return {
    deviceIds: [],
    taxiIds: [],
    campaignIds: [],
    customerIds: [],
    mediaIds: [],
    registrationCodeIds: [],
  };
}

export interface RegisteredDevice {
  deviceId: string;
  privateKey: KeyObject;
  publicKeySpki: string;
}

export interface DeviceSession extends RegisteredDevice {
  accessToken: string;
  label: string;
}

export function deviceHeaders(
  device: DeviceSession,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    host: HOST,
    authorization: "Bearer " + device.accessToken,
    "x-gt-ads-api-version": "1",
    ...extra,
  };
}

export async function createRegistrationCode(
  app: FastifyInstance,
  admin: AdminSession,
  resources: ChainResources,
  label: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/registration-codes",
    headers: adminHeaders(admin),
    payload: { label },
    remoteAddress: "192.0.2.201",
  });
  requireStatus(response, 201, "Registrierungscode anlegen");
  const body = responseJson<{ id?: unknown; code?: unknown }>(response);
  if (typeof body.id !== "string" || typeof body.code !== "string") {
    throw new Error("CX-063: Registrierungscode-Antwort ist unvollstaendig.");
  }
  resources.registrationCodeIds.push(body.id);
  return body.code;
}

export async function registerDevice(
  app: FastifyInstance,
  admin: AdminSession,
  resources: ChainResources,
  label: string,
): Promise<RegisteredDevice> {
  const code = await createRegistrationCode(app, admin, resources, label);
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = pair.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");

  const response = await app.inject({
    method: "POST",
    url: "/v1/device/register",
    headers: {
      host: HOST,
      "content-type": "application/json",
      "x-gt-ads-api-version": "1",
    },
    payload: {
      registration_code: code,
      client_request_id: randomUUID(),
      public_key: spki,
      app_env: "test",
      device_info: { ...DEVICE_INFO },
    },
    remoteAddress: "192.0.2.202",
  });
  requireStatus(response, 201, "Geraet registrieren (" + label + ")");
  const body = responseJson<{ device_id?: unknown }>(response);
  if (typeof body.device_id !== "string") {
    throw new Error("CX-063: Registrierungsantwort enthaelt keine device_id.");
  }
  resources.deviceIds.push(body.device_id);
  return {
    deviceId: body.device_id,
    privateKey: pair.privateKey,
    publicKeySpki: spki,
  };
}

function signChallenge(
  privateKey: KeyObject,
  deviceId: string,
  nonce: string,
): string {
  return signWithKey(
    "sha256",
    Buffer.from(buildSignatureMessage(deviceId, nonce), "utf8"),
    { key: privateKey, dsaEncoding: "der" },
  ).toString("base64");
}

export async function authenticateDevice(
  app: FastifyInstance,
  device: RegisteredDevice,
  label: string,
): Promise<DeviceSession> {
  const challengeResponse = await app.inject({
    method: "POST",
    url: "/v1/device/auth/challenge",
    headers: {
      host: HOST,
      "content-type": "application/json",
      "x-gt-ads-api-version": "1",
    },
    payload: { device_id: device.deviceId },
    remoteAddress: "192.0.2.203",
  });
  requireStatus(
    challengeResponse,
    200,
    "Challenge anfordern (" + label + ")",
  );
  const challenge = responseJson<{ nonce?: unknown }>(challengeResponse);
  if (typeof challenge.nonce !== "string") {
    throw new Error("CX-063: Challenge-Antwort enthaelt keine Nonce.");
  }

  const tokenResponse = await app.inject({
    method: "POST",
    url: "/v1/device/auth/token",
    headers: {
      host: HOST,
      "content-type": "application/json",
      "x-gt-ads-api-version": "1",
    },
    payload: {
      device_id: device.deviceId,
      nonce: challenge.nonce,
      signature: signChallenge(device.privateKey, device.deviceId, challenge.nonce),
    },
    remoteAddress: "192.0.2.203",
  });
  requireStatus(tokenResponse, 200, "Geraetetoken ausstellen (" + label + ")");
  const token = responseJson<{ access_token?: unknown }>(tokenResponse);
  if (typeof token.access_token !== "string") {
    throw new Error("CX-063: Token-Antwort enthaelt kein access_token.");
  }
  return {
    ...device,
    label,
    accessToken: token.access_token,
  };
}

export interface TaxiHandle {
  taxiId: string;
  revision: number;
}

export async function createTaxi(
  pool: Pool,
  resources: ChainResources,
  taxiId: string,
  displayName: string,
): Promise<TaxiHandle> {
  // CX-035-HTTP-Routen fehlen im Integrationsstand. Taxi-Stammdaten sind
  // technische Testkonfiguration und werden ueber die vorhandene Tabelle
  // angelegt; die Kette selbst laeuft danach ausschliesslich ueber HTTP.
  await ensureTaxiActivationSchema(pool);
  await pool.query(
    "insert into taxis (id, display_name, active, revision)" +
      " values ($1, $2, true, 1)" +
      " on conflict (id) do update set display_name = excluded.display_name",
    [taxiId, displayName],
  );
  resources.taxiIds.push(taxiId);
  return { taxiId, revision: 1 };
}

export async function assignTablets(
  pool: Pool,
  taxi: TaxiHandle,
  firstDeviceId: string,
  secondDeviceId: string,
): Promise<number> {
  // Technische Testkonfiguration der fehlenden CX-035-Zuordnungsroute.
  await pool.query(
    "insert into device_taxi_assignments" +
      " (device_id, taxi_id, active, updated_at)" +
      " values ($1::uuid, $3, true, $4), ($2::uuid, $3, true, $4)" +
      " on conflict (device_id, taxi_id) do update" +
      " set active = true, updated_at = excluded.updated_at",
    [firstDeviceId, secondDeviceId, taxi.taxiId, new Date(BASE_TIME)],
  );
  return taxi.revision;
}

export interface UploadedMedia {
  id: string;
  sha256: string;
  sizeBytes: number;
  bytes: Buffer;
}

export async function uploadSyntheticMedia(
  app: FastifyInstance,
  admin: AdminSession,
  resources: ChainResources,
  bytes: Buffer,
): Promise<UploadedMedia> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/media?name=" + encodeURIComponent("SYN-CX063-Spot.mp4"),
    headers: adminHeaders(admin, { "content-type": "application/octet-stream" }),
    payload: bytes,
    remoteAddress: "192.0.2.206",
  });
  if (response.statusCode === 422) {
    throw new Error(
      "CX-063: POST /v1/admin/media endet mit 422, weil die zentrale" +
        " Komposition dem vorhandenen CX-030-Service keine Profilmetadaten" +
        " uebergibt (metadata: undefined). Ohne den fehlenden serverseitigen" +
        " Metadatenleser ist kein echter Upload ueber die vorhandene API" +
        " moeglich.",
    );
  }
  requireStatus(response, 201, "Synthetisches MP4 hochladen");
  const body = responseJson<{
    id?: unknown;
    sha256?: unknown;
    size_bytes?: unknown;
  }>(response);
  if (
    typeof body.id !== "string" ||
    typeof body.sha256 !== "string" ||
    typeof body.size_bytes !== "number"
  ) {
    throw new Error("CX-063: Upload-Antwort ist unvollstaendig.");
  }
  resources.mediaIds.push(body.id);
  return {
    id: body.id,
    sha256: body.sha256,
    sizeBytes: body.size_bytes,
    bytes,
  };
}

export async function createCustomer(
  app: FastifyInstance,
  admin: AdminSession,
  resources: ChainResources,
  displayName: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/customers",
    headers: adminHeaders(admin),
    payload: { display_name: displayName },
    remoteAddress: "192.0.2.207",
  });
  requireStatus(response, 201, "Kunden anlegen");
  const body = responseJson<{ id?: unknown }>(response);
  if (typeof body.id !== "string") {
    throw new Error("CX-063: Kundenantwort enthaelt keine id.");
  }
  resources.customerIds.push(body.id);
  return body.id;
}

export async function createActiveCampaign(
  app: FastifyInstance,
  admin: AdminSession,
  resources: ChainResources,
  input: { customerId: string; mediaId: string; taxiId: string },
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/campaigns",
    headers: adminHeaders(admin),
    payload: {
      customer_id: input.customerId,
      media_id: input.mediaId,
      start_at: "2026-11-15T00:00:00.000Z",
      end_at: "2026-11-15T23:59:59.999Z",
      status: "active",
      taxi_ids: [input.taxiId],
      group_ids: [],
    },
    remoteAddress: "192.0.2.208",
  });
  requireStatus(response, 201, "Aktive Kampagne anlegen");
  const body = responseJson<{ id?: unknown; status?: unknown }>(response);
  if (typeof body.id !== "string" || body.status !== "active") {
    throw new Error("CX-063: Kampagnenantwort ist nicht aktiv oder ohne id.");
  }
  resources.campaignIds.push(body.id);
  return body.id;
}

export interface ManifestSigning {
  keyId: string;
  privateKey: KeyObject;
  trustedKeys: Map<string, KeyObject>;
}

export function createManifestSigning(): ManifestSigning {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    keyId: "cx063-test",
    privateKey: pair.privateKey,
    trustedKeys: new Map([["cx063-test", pair.publicKey]]),
  };
}

export async function refreshManifest(
  pool: Pool,
  clock: MutableClock,
  signing: ManifestSigning,
): Promise<{ published: number; failed: number; items: unknown[] }> {
  const service = new ManifestRefreshService({
    pool,
    signingKey: signing.privateKey,
    keyId: signing.keyId,
    environment: "test",
    trustedKeys: signing.trustedKeys,
    now: clock.now,
    slotCount: 12,
    fallbackMediaId: null,
  });
  const result = await service.drainPending({ limit: 10 });
  if (result.failed > 0) {
    throw new Error(
      "CX-063: Manifest-Neuberechnung ist fehlgeschlagen: " +
        JSON.stringify(result.items),
    );
  }
  return {
    published: result.published,
    failed: result.failed,
    items: result.items,
  };
}

export interface FetchedManifest {
  envelope: SignedManifestEnvelope;
  verified: VerifiedManifest;
  body: Buffer;
  etag: string | undefined;
}

export async function fetchManifest(
  app: FastifyInstance,
  device: DeviceSession,
  taxiId: string,
  signing: ManifestSigning,
): Promise<FetchedManifest> {
  const response = await app.inject({
    method: "GET",
    url: "/v1/device/manifest",
    headers: deviceHeaders(device),
    remoteAddress: "192.0.2.209",
  });
  requireStatus(response, 200, "Manifest abrufen (" + device.label + ")");
  const envelope = responseJson<SignedManifestEnvelope>(response);
  let verified: VerifiedManifest;
  try {
    verified = verifySignedManifest(envelope, {
      taxiId,
      environment: "test",
      trustedKeys: signing.trustedKeys,
    });
  } catch (error) {
    throw new Error(
      "CX-063: Manifest-Signatur ist nicht gueltig: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  return {
    envelope,
    verified,
    body: Buffer.from(response.body, "utf8"),
    etag:
      typeof response.headers.etag === "string" ? response.headers.etag : undefined,
  };
}

export function issueReleaseTicket(input: {
  device: DeviceSession;
  taxiId: string;
  verified: VerifiedManifest;
  mediaId: string;
  clock: MutableClock;
}): string {
  return issueDownloadTicket({
    deviceId: input.device.deviceId,
    deviceTaxiBinding: {
      deviceId: input.device.deviceId,
      taxiId: input.taxiId,
      authorized: true,
    },
    manifest: input.verified,
    mediaId: input.mediaId,
    secret: DOWNLOAD_SECRET,
    clock: input.clock.now,
  }).ticket;
}

export async function downloadMedia(
  app: FastifyInstance,
  device: DeviceSession,
  mediaId: string,
  ticket: string,
  options: { range?: string; ifRange?: string } = {},
): Promise<ResponseLike> {
  const headers = deviceHeaders(device);
  if (options.range !== undefined) {
    headers.range = options.range;
  }
  if (options.ifRange !== undefined) {
    headers["if-range"] = options.ifRange;
  }
  const url =
    "/v1/device/downloads/" +
    encodeURIComponent(mediaId) +
    "?ticket=" +
    encodeURIComponent(ticket);
  const response = await app.inject({
    method: "GET",
    url,
    headers,
    remoteAddress: "192.0.2.210",
  });
  return response;
}

export interface PauseResult {
  status?: string;
  command_id?: string;
  revision?: number;
  desired_paused?: boolean;
  acknowledgements_pending?: boolean;
  idempotent?: boolean;
  target_device_ids?: string[];
}

export async function pauseTaxi(
  app: FastifyInstance,
  admin: AdminSession,
  taxiId: string,
  commandId: string,
  expectedRevision: number,
): Promise<PauseResult> {
  const url =
    "/v1/admin/taxis/" + encodeURIComponent(taxiId) + "/pause";
  const response = await app.inject({
    method: "POST",
    url,
    headers: adminHeaders(admin),
    payload: {
      command_id: commandId,
      expected_revision: expectedRevision,
    },
    remoteAddress: "192.0.2.211",
  });
  requireStatus(response, 202, "Taxiweite Pause setzen");
  return responseJson<PauseResult>(response);
}

export interface DeviceCommandsResult {
  commands: Array<{
    command_id: string;
    revision: number;
    desired_paused: boolean;
  }>;
  taxi_fully_applied: boolean;
}

export async function getDeviceCommands(
  app: FastifyInstance,
  device: DeviceSession,
): Promise<DeviceCommandsResult> {
  const response = await app.inject({
    method: "GET",
    url: "/v1/device/commands",
    headers: deviceHeaders(device),
    remoteAddress: "192.0.2.212",
  });
  requireStatus(response, 200, "Pausenauftrag abrufen (" + device.label + ")");
  return responseJson<DeviceCommandsResult>(response);
}

export interface AckResult {
  status?: string;
  command_id?: string;
  revision?: number;
  duplicate?: boolean;
  taxi_fully_applied?: boolean;
}

export async function acknowledgeCommand(
  app: FastifyInstance,
  device: DeviceSession,
  commandId: string,
  revision: number,
): Promise<AckResult> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/device/commands/ack",
    headers: deviceHeaders(device, { "content-type": "application/json" }),
    payload: { command_id: commandId, revision },
    remoteAddress: "192.0.2.213",
  });
  requireStatus(response, 200, "Pausenauftrag quittieren (" + device.label + ")");
  return responseJson<AckResult>(response);
}

export interface EventIngestResult {
  accepted_event_ids?: string[];
  inserted_event_ids?: string[];
  duplicate_event_ids?: string[];
}

export async function sendDeviceEvents(
  app: FastifyInstance,
  device: DeviceSession,
  events: SyntheticEvent[],
): Promise<EventIngestResult> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/device/events",
    headers: deviceHeaders(device, { "content-type": "application/json" }),
    payload: { events },
    remoteAddress: "192.0.2.214",
  });
  requireStatus(response, 200, "Wiedergabeereignisse senden (" + device.label + ")");
  return responseJson<EventIngestResult>(response);
}

export interface PauseCounts {
  commands: number;
  deliveries: number;
  pending: number;
  audit: number;
  state: number;
  revision: number;
}

export async function pauseCounts(
  pool: Pool,
  taxiId: string,
): Promise<PauseCounts> {
  const result = await pool.query<PauseCounts>(
    [
      "select",
      "  (select count(*) from remote_control_commands",
      "     where taxi_id = $1)::int as commands,",
      "  (select count(*) from remote_control_deliveries",
      "     where taxi_id = $1)::int as deliveries,",
      "  (select count(*) from remote_control_deliveries",
      "     where taxi_id = $1 and status = 'pending')::int as pending,",
      "  (select count(*) from audit_events",
      "     where action = $2 and target_id = $1)::int as audit,",
      "  (select count(*) from remote_control_taxi_state",
      "     where taxi_id = $1)::int as state,",
      "  coalesce((select revision::int from remote_control_taxi_state",
      "     where taxi_id = $1), 0) as revision",
    ].join("\n"),
    [taxiId, REMOTE_CONTROL_AUDIT_ACTION],
  );
  return result.rows[0]!;
}

export async function countDeviceEvents(
  pool: Pool,
  deviceId: string,
  eventIds: readonly string[],
): Promise<number> {
  const result = await pool.query<{ count: number }>(
    [
      "select count(*)::int as count",
      "  from telemetry_observations",
      " where device_id = $1",
      "   and event_id = any($2::uuid[])",
    ].join("\n"),
    [deviceId, eventIds],
  );
  return result.rows[0]?.count ?? 0;
}

export async function countDeliveries(
  pool: Pool,
  taxiId: string,
  status: "pending" | "applied" | "superseded",
): Promise<number> {
  const result = await pool.query<{ count: number }>(
    "select count(*)::int as count from remote_control_deliveries" +
      " where taxi_id = $1 and status = $2",
    [taxiId, status],
  );
  return result.rows[0]?.count ?? 0;
}

export async function cleanupResources(
  pool: Pool,
  resources: ChainResources,
  storageRoot: string,
): Promise<void> {
  const deviceIds = resources.deviceIds;
  const taxiIds = resources.taxiIds;
  const campaignIds = resources.campaignIds;
  const customerIds = resources.customerIds;
  const mediaIds = resources.mediaIds;
  const registrationCodeIds = resources.registrationCodeIds;

  const statements: Array<[string, unknown[]]> = [
    [
      "delete from telemetry_observations where device_id = any($1::uuid[])",
      [deviceIds],
    ],
    [
      "delete from remote_control_deliveries where taxi_id = any($1::text[])",
      [taxiIds],
    ],
    [
      "delete from remote_control_commands where taxi_id = any($1::text[])",
      [taxiIds],
    ],
    [
      "delete from remote_control_taxi_state where taxi_id = any($1::text[])",
      [taxiIds],
    ],
    [
      "delete from taxi_manifest_artifacts where taxi_id = any($1::text[])",
      [taxiIds],
    ],
    [
      "delete from taxi_manifest_state where taxi_id = any($1::text[])",
      [taxiIds],
    ],
    [
      "delete from campaign_targets where campaign_id = any($1::uuid[])",
      [campaignIds],
    ],
    [
      "delete from campaigns where id = any($1::uuid[])",
      [campaignIds],
    ],
    [
      "delete from media_objects where id = any($1::uuid[])",
      [mediaIds],
    ],
    [
      "delete from device_taxi_assignments" +
        " where device_id = any($1::uuid[]) or taxi_id = any($2::text[])",
      [deviceIds, taxiIds],
    ],
    [
      "delete from tablet_admin_states where device_id = any($1::uuid[])",
      [deviceIds],
    ],
    [
      "delete from device_access_tokens where device_id = any($1::uuid[])",
      [deviceIds],
    ],
    [
      "delete from device_auth_challenges where device_id = any($1::uuid[])",
      [deviceIds],
    ],
    [
      "delete from devices where id = any($1::uuid[])",
      [deviceIds],
    ],
    [
      "delete from registration_codes where id = any($1::uuid[])",
      [registrationCodeIds],
    ],
    [
      "delete from taxis where id = any($1::text[])",
      [taxiIds],
    ],
    [
      "delete from customers where id = any($1::uuid[])",
      [customerIds],
    ],
  ];

  for (const [sql, params] of statements) {
    try {
      await pool.query(sql, params);
    } catch {
      // Best-effort: Die eigene Testdatenbank wird am Laufende verworfen.
    }
  }

  const targetIds = [
    ...deviceIds,
    ...taxiIds,
    ...campaignIds,
    ...customerIds,
    ...mediaIds,
    ...registrationCodeIds,
  ];
  if (targetIds.length > 0) {
    try {
      await pool.query(
        "delete from audit_events where target_id = any($1::text[])",
        [targetIds],
      );
    } catch {
      // Best-effort.
    }
  }

  for (const mediaId of mediaIds) {
    await rm(join(storageRoot, "objects", mediaId), { force: true }).catch(
      () => undefined,
    );
    await rm(join(storageRoot, "staging", mediaId + ".part"), {
      force: true,
    }).catch(() => undefined);
  }
}

export { BASE_TIME, MEDIA_DURATION_SECONDS, syntheticEvents };
