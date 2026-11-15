/**
 * CX-063 / R-801: synthetischer API-Kettentest.
 *
 * Die vier Faelle laufen ausschliesslich ueber die echte zentrale Fastify-App
 * (CX-033) via inject, echte Migrationen, eine laufbezogene PostgreSQL-
 * Datenbank und einen temporaeren Medienspeicher. Es gibt keine Mocks fuer
 * Fachhandler, Repositorys, Signaturen, Geraeteauthentifizierung oder
 * Manifest-Erzeugung.
 *
 * Die Kette wird ueber die vorhandenen HTTP-APIs aufgebaut: Admin-Sitzung,
 * Registrierungscode, Geraeteregistrierung, Challenge/Response, Taxi- und
 * Tabletzuordnung, Medienupload, Kunde, aktive Kampagne, Manifest, signierter
 * Medienabruf, Wiedergabeereignisse und taxiweite Pause.
 *
 * Der Integrationsstand enthaelt zwei fehlende Vorstufen, die hier transparent
 * als technische Testhilfen behandelt werden:
 * - CX-035 besitzt keine HTTP-Routen fuer Taxi-Anlage und Tabletzuordnung;
 *   Taxi und Zuordnung werden deshalb als technische Testkonfiguration
 *   angelegt.
 * - CX-008 besitzt keine HTTP-Route fuer den signierten Download; support.ts
 *   stellt dafuer einen lokalen Transportadapter bereit, der ausschliesslich
 *   den echten Downloaddienst, die echte Geraeteauthentifizierung und echte
 *   Datenbank-/Dateizugriffe aufruft.
 * - Der serverseitige Upload-Metadatenleser fehlt; die Metadaten des
 *   synthetischen MP4 werden ueber die vorhandene Testkomposition explizit
 *   uebergeben.
 *
 * Signatur, Manifest-Erzeugung, Authentifizierung, Persistenz und die
 * Fachkerne selbst werden nicht gemockt.
 */
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../../../src/config.js";
import {
  BASE_TIME,
  MEDIA_DURATION_SECONDS,
  sha256Hex,
  syntheticEvents,
  syntheticMp4,
  uniqueId,
} from "./fixtures.js";
import {
  acknowledgeCommand,
  adminHeaders,
  assignTablets,
  authenticateDevice,
  buildApp,
  cleanupResources,
  countDeliveries,
  countDeviceEvents,
  createActiveCampaign,
  createClock,
  createCustomer,
  createManifestSigning,
  createResources,
  createRunStorageRoot,
  createTaxi,
  createTestConfig,
  deviceHeaders,
  downloadMedia,
  fetchManifest,
  getDeviceCommands,
  issueReleaseTicket,
  loginAdmin,
  openRunDatabase,
  pauseCounts,
  pauseTaxi,
  refreshManifest,
  registerDevice,
  requireStatus,
  sendDeviceEvents,
  uploadSyntheticMedia,
  type AdminSession,
  type ChainResources,
  type DeviceSession,
  type FetchedManifest,
  type ManifestSigning,
  type MutableClock,
  type RunDatabase,
  type TaxiHandle,
  type UploadedMedia,
} from "./support.js";

let run: RunDatabase;
let config: AppConfig;
let storageRoot = "";
let previousStorageRoot: string | undefined;
const openApps: FastifyInstance[] = [];

beforeAll(async () => {
  run = await openRunDatabase();
  config = await createTestConfig();
  storageRoot = await createRunStorageRoot();
  previousStorageRoot = process.env.GT_ADS_MEDIA_STORAGE_ROOT;
  process.env.GT_ADS_MEDIA_STORAGE_ROOT = storageRoot;
}, 180_000);

afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await app.close();
  }
});

afterAll(async () => {
  if (previousStorageRoot === undefined) {
    delete process.env.GT_ADS_MEDIA_STORAGE_ROOT;
  } else {
    process.env.GT_ADS_MEDIA_STORAGE_ROOT = previousStorageRoot;
  }
  if (run !== undefined) {
    await run.close();
  }
  if (storageRoot !== "") {
    await rm(storageRoot, { recursive: true, force: true });
  }
}, 60_000);

interface OpenApp {
  app: FastifyInstance;
  clock: MutableClock;
  admin: AdminSession;
}

async function openApp(): Promise<OpenApp> {
  const clock = createClock();
  const app = await buildApp(config, run.pool, clock, storageRoot);
  openApps.push(app);
  const admin = await loginAdmin(app);
  return { app, clock, admin };
}

async function prepareDevices(
  app: FastifyInstance,
  admin: AdminSession,
  resources: ChainResources,
  tag: string,
): Promise<[DeviceSession, DeviceSession]> {
  const first = await registerDevice(
    app,
    admin,
    resources,
    "SYN-CX063-" + tag + "-Tablet-A",
  );
  const second = await registerDevice(
    app,
    admin,
    resources,
    "SYN-CX063-" + tag + "-Tablet-B",
  );
  const firstSession = await authenticateDevice(app, first, tag + "-A");
  const secondSession = await authenticateDevice(app, second, tag + "-B");
  return [firstSession, secondSession];
}

async function prepareTaxi(
  app: FastifyInstance,
  admin: AdminSession,
  resources: ChainResources,
  tag: string,
): Promise<{ taxi: TaxiHandle; devices: [DeviceSession, DeviceSession] }> {
  const devices = await prepareDevices(app, admin, resources, tag);
  const taxi = await createTaxi(
    run.pool,
    resources,
    uniqueId("SYN-CX063-TAXI-" + tag),
    "SYN CX-063 " + tag,
  );
  const revision = await assignTablets(
    run.pool,
    taxi,
    devices[0].deviceId,
    devices[1].deviceId,
  );
  return { taxi: { ...taxi, revision }, devices };
}

interface ChainData {
  taxi: TaxiHandle;
  first: DeviceSession;
  second: DeviceSession;
  bytes: Buffer;
  upload: UploadedMedia;
  customerId: string;
  campaignId: string;
  signing: ManifestSigning;
  manifest: FetchedManifest;
}

async function prepareChain(
  app: FastifyInstance,
  admin: AdminSession,
  clock: MutableClock,
  resources: ChainResources,
  tag: string,
): Promise<ChainData> {
  const { taxi, devices } = await prepareTaxi(app, admin, resources, tag);
  const bytes = syntheticMp4();
  const upload = await uploadSyntheticMedia(app, admin, resources, bytes);
  const customerId = await createCustomer(
    app,
    admin,
    resources,
    "SYN-CX063-Kunde-" + tag,
  );
  const campaignId = await createActiveCampaign(app, admin, resources, {
    customerId,
    mediaId: upload.id,
    taxiId: taxi.taxiId,
  });
  const signing = createManifestSigning();
  const refresh = await refreshManifest(run.pool, clock, signing);
  if (refresh.published < 1) {
    throw new Error(
      "CX-063: Die aktive Kampagne hat kein Manifest veroeffentlicht." +
        " Erwartet wurde mindestens eine Veroeffentlichung, erhalten: " +
        JSON.stringify(refresh),
    );
  }
  const manifest = await fetchManifest(app, devices[0], taxi.taxiId, signing);
  return {
    taxi,
    first: devices[0],
    second: devices[1],
    bytes,
    upload,
    customerId,
    campaignId,
    signing,
    manifest,
  };
}

function firstSpot(manifest: FetchedManifest): {
  mediaId: string;
  sha256: string;
  sizeBytes: number;
  durationMs: number;
  campaignId: string;
} {
  const spot = manifest.verified.plan.spots[0];
  if (spot === undefined) {
    throw new Error("CX-063: Das verifizierte Manifest enthaelt keinen Spot.");
  }
  return spot;
}

function payloadBytes(response: { rawPayload?: Buffer; body: string }): Buffer {
  return response.rawPayload ?? Buffer.from(response.body, "binary");
}

async function readStoredMedia(mediaId: string): Promise<Buffer> {
  return readFile(join(storageRoot, "objects", mediaId));
}

describe("CX-063 / R-801 Produktkette", () => {
  it("registriert zwei Tablets, ordnet sie einem Taxi zu, laedt einen Spot hoch und ruft das signierte Manifest sowie das Medium ab", async () => {
    const resources = createResources();
    const { app, clock, admin } = await openApp();
    try {
      const data = await prepareChain(app, admin, clock, resources, "T1");
      const spot = firstSpot(data.manifest);

      expect(spot.mediaId).toBe(data.upload.id);
      expect(spot.sha256).toBe(data.upload.sha256);
      expect(spot.sizeBytes).toBe(data.upload.sizeBytes);
      expect(spot.durationMs).toBe(MEDIA_DURATION_SECONDS * 1000);
      expect(spot.campaignId).toBe(data.campaignId);
      expect(data.manifest.verified.plan.taxiId).toBe(data.taxi.taxiId);
      expect(data.manifest.envelope.keyId).toBe(data.signing.keyId);
      expect(data.manifest.envelope.version).toMatch(/^[0-9a-f]{64}$/);

      const mediaRows = await run.pool.query<{
        sha256: string;
        size_bytes: string;
        status: string;
      }>(
        "select sha256, size_bytes::text as size_bytes, status" +
          " from media_objects where id = $1",
        [data.upload.id],
      );
      expect(mediaRows.rows).toHaveLength(1);
      expect(mediaRows.rows[0]?.sha256).toBe(data.upload.sha256);
      expect(Number(mediaRows.rows[0]?.size_bytes)).toBe(data.upload.sizeBytes);
      expect(mediaRows.rows[0]?.status).toBe("ready");

      const stored = await readStoredMedia(data.upload.id);
      expect(stored.equals(data.bytes)).toBe(true);
      expect(sha256Hex(stored)).toBe(data.upload.sha256);

      const artifactRows = await run.pool.query<{
        version: string;
        signature_base64: string;
      }>(
        "select version, signature_base64 from taxi_manifest_artifacts" +
          " where taxi_id = $1 and version = $2",
        [data.taxi.taxiId, data.manifest.envelope.version],
      );
      expect(artifactRows.rows).toHaveLength(1);
      expect(artifactRows.rows[0]?.signature_base64).toBe(
        data.manifest.envelope.signatureBase64,
      );

      const ticket = issueReleaseTicket({
        device: data.first,
        taxiId: data.taxi.taxiId,
        verified: data.manifest.verified,
        mediaId: data.upload.id,
        clock,
      });
      const full = await downloadMedia(app, data.first, data.upload.id, ticket);
      requireStatus(full, 200, "Vollstaendiger Medienabruf");
      const downloaded = payloadBytes(full);
      expect(downloaded.equals(data.bytes)).toBe(true);
      expect(sha256Hex(downloaded)).toBe(data.upload.sha256);
      expect(String(full.headers.etag)).toBe('"' + data.upload.sha256 + '"');

      const events = syntheticEvents(3);
      const eventResult = await sendDeviceEvents(app, data.first, events);
      expect(eventResult.inserted_event_ids).toHaveLength(3);
      expect(
        await countDeviceEvents(
          run.pool,
          data.first.deviceId,
          events.map((event) => event.event_id),
        ),
      ).toBe(3);

      const commandId = randomUUID();
      const paused = await pauseTaxi(
        app,
        admin,
        data.taxi.taxiId,
        commandId,
        0,
      );
      expect(paused).toMatchObject({
        status: "accepted",
        command_id: commandId,
        revision: 1,
        desired_paused: true,
        acknowledgements_pending: true,
      });

      const firstCommands = await getDeviceCommands(app, data.first);
      const secondCommands = await getDeviceCommands(app, data.second);
      expect(firstCommands.commands).toHaveLength(1);
      expect(firstCommands.commands[0]).toMatchObject({
        command_id: commandId,
        revision: 1,
        desired_paused: true,
      });
      expect(secondCommands.commands[0]).toMatchObject({
        command_id: commandId,
        revision: 1,
        desired_paused: true,
      });

      // Der Abruf allein ist keine Ausfuehrungsbestaetigung.
      expect(firstCommands.taxi_fully_applied).toBe(false);
      expect(secondCommands.taxi_fully_applied).toBe(false);
      expect(await countDeliveries(run.pool, data.taxi.taxiId, "applied")).toBe(0);
      expect(await pauseCounts(run.pool, data.taxi.taxiId)).toMatchObject({
        commands: 1,
        deliveries: 2,
        pending: 2,
        audit: 1,
        state: 1,
        revision: 1,
      });

      const firstAck = await acknowledgeCommand(app, data.first, commandId, 1);
      expect(firstAck).toMatchObject({
        status: "acknowledged",
        command_id: commandId,
        revision: 1,
        duplicate: false,
        taxi_fully_applied: false,
      });
      const secondAck = await acknowledgeCommand(app, data.second, commandId, 1);
      expect(secondAck).toMatchObject({
        status: "acknowledged",
        command_id: commandId,
        revision: 1,
        duplicate: false,
        taxi_fully_applied: true,
      });
      expect(await countDeliveries(run.pool, data.taxi.taxiId, "applied")).toBe(2);
      expect((await pauseCounts(run.pool, data.taxi.taxiId)).pending).toBe(0);
    } finally {
      await cleanupResources(run.pool, resources, storageRoot);
    }
  });

  it("erzeugt bei identischen Wiedergabeereignissen und demselben Pausenauftrag keine zusaetzlichen Zeilen, Revisionen oder Audit-Erfolge", async () => {
    const resources = createResources();
    const { app, clock, admin } = await openApp();
    try {
      const data = await prepareChain(app, admin, clock, resources, "T2");
      const events = syntheticEvents(2);

      const firstSend = await sendDeviceEvents(app, data.first, events);
      expect(firstSend.inserted_event_ids).toHaveLength(2);
      const secondSend = await sendDeviceEvents(app, data.first, events);
      expect(secondSend.inserted_event_ids).toHaveLength(0);
      expect(secondSend.duplicate_event_ids).toHaveLength(2);
      expect(
        await countDeviceEvents(
          run.pool,
          data.first.deviceId,
          events.map((event) => event.event_id),
        ),
      ).toBe(2);

      const commandId = randomUUID();
      const firstPause = await pauseTaxi(
        app,
        admin,
        data.taxi.taxiId,
        commandId,
        0,
      );
      const secondPause = await pauseTaxi(
        app,
        admin,
        data.taxi.taxiId,
        commandId,
        0,
      );
      expect(firstPause).toMatchObject({
        command_id: commandId,
        revision: 1,
        idempotent: false,
      });
      expect(secondPause).toMatchObject({
        command_id: commandId,
        revision: 1,
        idempotent: true,
      });

      const counts = await pauseCounts(run.pool, data.taxi.taxiId);
      expect(counts).toEqual({
        commands: 1,
        deliveries: 2,
        pending: 2,
        audit: 1,
        state: 1,
        revision: 1,
      });
      const commandRows = await run.pool.query<{ count: number; revision: number }>(
        [
          "select count(*)::int as count, coalesce(min(revision), 0)::int as revision",
          "  from remote_control_commands where taxi_id = $1",
        ].join("\n"),
        [data.taxi.taxiId],
      );
      expect(commandRows.rows[0]).toEqual({ count: 1, revision: 1 });

      const stateRows = await run.pool.query<{ revision: number }>(
        "select revision::int as revision from remote_control_taxi_state" +
          " where taxi_id = $1",
        [data.taxi.taxiId],
      );
      expect(stateRows.rows[0]?.revision).toBe(1);
    } finally {
      await cleanupResources(run.pool, resources, storageRoot);
    }
  });

  it("isoliert ein fremdes Taxi vom Manifest und Pausenauftrag und sperrt nach Widerruf die geraetegebundenen Endpunkte", async () => {
    const resources = createResources();
    const { app, clock, admin } = await openApp();
    try {
      const dataA = await prepareChain(app, admin, clock, resources, "T3A");
      const taxiB = await prepareTaxi(app, admin, resources, "T3B");

      const foreignManifest = await app.inject({
        method: "GET",
        url: "/v1/device/manifest",
        headers: deviceHeaders(taxiB.devices[0]),
        remoteAddress: "192.0.2.230",
      });
      expect(foreignManifest.statusCode).toBe(404);
      expect(foreignManifest.json().error.code).toBe("manifest_not_ready");
      expect(foreignManifest.body).not.toContain(
        dataA.manifest.envelope.version,
      );
      expect(foreignManifest.body).not.toContain(dataA.upload.id);

      const commandId = randomUUID();
      await pauseTaxi(app, admin, dataA.taxi.taxiId, commandId, 0);
      const ownCommands = await getDeviceCommands(app, dataA.first);
      expect(ownCommands.commands).toHaveLength(1);
      expect(ownCommands.commands[0]?.command_id).toBe(commandId);

      const foreignCommands = await getDeviceCommands(app, taxiB.devices[0]);
      expect(foreignCommands.commands).toEqual([]);
      expect(foreignCommands.taxi_fully_applied).toBe(false);

      const revoke = await app.inject({
        method: "POST",
        url: "/v1/admin/devices/" + taxiB.devices[0].deviceId + "/revoke",
        headers: adminHeaders(admin),
        payload: {},
        remoteAddress: "192.0.2.231",
      });
      requireStatus(revoke, 204, "Tablet widerrufen");

      const revokedManifest = await app.inject({
        method: "GET",
        url: "/v1/device/manifest",
        headers: deviceHeaders(taxiB.devices[0]),
        remoteAddress: "192.0.2.232",
      });
      expect(revokedManifest.statusCode).toBe(403);
      expect(revokedManifest.json().error.code).toBe("device_revoked");

      const revokedCommands = await app.inject({
        method: "GET",
        url: "/v1/device/commands",
        headers: deviceHeaders(taxiB.devices[0]),
        remoteAddress: "192.0.2.233",
      });
      expect(revokedCommands.statusCode).toBe(403);

      const revokedEvents = await app.inject({
        method: "POST",
        url: "/v1/device/events",
        headers: deviceHeaders(taxiB.devices[0], {
          "content-type": "application/json",
        }),
        payload: { events: syntheticEvents(1) },
        remoteAddress: "192.0.2.234",
      });
      expect(revokedEvents.statusCode).toBe(403);

      const ownManifest = await app.inject({
        method: "GET",
        url: "/v1/device/manifest",
        headers: deviceHeaders(dataA.first),
        remoteAddress: "192.0.2.235",
      });
      requireStatus(ownManifest, 200, "Manifest des nicht widerrufenen Tablets");

      const deviceRow = await run.pool.query<{ state: string }>(
        "select state from devices where id = $1",
        [taxiB.devices[0].deviceId],
      );
      expect(deviceRow.rows[0]?.state).toBe("revoked");
    } finally {
      await cleanupResources(run.pool, resources, storageRoot);
    }
  });

  it("liefert bei fortgesetztem Download exakte Teilbytes, deren Zusammensetzung Hash und Manifest entsprechen, und lehnt eine manipulierte Freigabe ab", async () => {
    const resources = createResources();
    const { app, clock, admin } = await openApp();
    try {
      const data = await prepareChain(app, admin, clock, resources, "T4");
      const spot = firstSpot(data.manifest);
      const ticket = issueReleaseTicket({
        device: data.first,
        taxiId: data.taxi.taxiId,
        verified: data.manifest.verified,
        mediaId: data.upload.id,
        clock,
      });

      const full = await downloadMedia(app, data.first, data.upload.id, ticket);
      requireStatus(full, 200, "Vollstaendiger Download vor Range");
      const fullBytes = payloadBytes(full);
      expect(fullBytes.equals(data.bytes)).toBe(true);
      expect(sha256Hex(fullBytes)).toBe(spot.sha256);
      const etag = String(full.headers.etag);

      const first = await downloadMedia(
        app,
        data.first,
        data.upload.id,
        ticket,
        { range: "bytes=0-1023", ifRange: etag },
      );
      requireStatus(first, 206, "Erster Teilbereich");
      expect(String(first.headers["content-range"])).toBe(
        "bytes 0-1023/" + data.bytes.length,
      );
      expect(payloadBytes(first).length).toBe(1024);

      const second = await downloadMedia(
        app,
        data.first,
        data.upload.id,
        ticket,
        { range: "bytes=1024-", ifRange: etag },
      );
      requireStatus(second, 206, "Fortgesetzter Teilbereich");
      expect(String(second.headers["content-range"])).toBe(
        "bytes 1024-" + (data.bytes.length - 1) + "/" + data.bytes.length,
      );

      const joined = Buffer.concat([payloadBytes(first), payloadBytes(second)]);
      expect(joined.equals(data.bytes)).toBe(true);
      expect(joined.length).toBe(data.bytes.length);
      expect(sha256Hex(joined)).toBe(spot.sha256);
      expect(sha256Hex(joined)).toBe(data.upload.sha256);

      const wrongDevice = await downloadMedia(
        app,
        data.second,
        data.upload.id,
        ticket,
      );
      requireStatus(wrongDevice, 403, "Fremdes Geraet mit gueltigem Ticket");

      const parts = ticket.split(".");
      const encodedPayload = parts[0] as string;
      const mac = parts[1] as string;
      const tamperedMac =
        mac.slice(0, -2) + (mac.endsWith("AA") ? "BB" : "AA");
      const tampered = encodedPayload + "." + tamperedMac;
      const rejected = await downloadMedia(
        app,
        data.first,
        data.upload.id,
        tampered,
      );
      requireStatus(rejected, 403, "Manipulierte Freigabe");

      const stored = await readStoredMedia(data.upload.id);
      expect(sha256Hex(stored)).toBe(spot.sha256);
      expect(stored.length).toBe(spot.sizeBytes);
    } finally {
      await cleanupResources(run.pool, resources, storageRoot);
    }
  });
});
