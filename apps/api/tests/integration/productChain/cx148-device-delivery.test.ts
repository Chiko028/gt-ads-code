/**
 * CX-148: Auslieferungskette ohne Testhilfen. Mit konfiguriertem Signierschluessel und
 * Download-Geheimnis erzeugt der Server nach einer Kampagnenaktivierung selbst das signierte
 * Manifest (CX-041 verdrahtet); das Tablet holt ueber die neuen Geraeterouten Konfiguration,
 * Download-Freigabe und das Medium (ganz und fortgesetzt). Echte App, echte Datenbank,
 * echte Geraeteauthentifizierung; kein lokaler Download-Transport wie in R-801.
 */
import { createHash, generateKeyPairSync, createPublicKey } from "node:crypto";
import { rm } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../../../src/config.js";
import { createServer } from "../../../src/http/server.js";
import { createMedia } from "../../../src/modules/media/index.js";
import { verifySignedManifest, type SignedManifestEnvelope } from "../../../src/modules/playout/manifest.js";
import { MEDIA_DURATION_SECONDS, syntheticMp4, uniqueId } from "./fixtures.js";
import {
  assignTablets,
  authenticateDevice,
  cleanupResources,
  createActiveCampaign,
  createClock,
  createCustomer,
  createResources,
  createRunStorageRoot,
  createTaxi,
  createTestConfig,
  deviceHeaders,
  loginAdmin,
  openRunDatabase,
  registerDevice,
  uploadSyntheticMedia,
  type ChainResources,
  type RunDatabase,
} from "./support.js";

const KEY_ID = "cx148-test";
const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const PEM = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const SECRET = "SYN-CX148-download-secret-0123456789abcdef";

let run: RunDatabase;
let config: AppConfig;
let storageRoot = "";
let previousStorageRoot: string | undefined;
const openApps: FastifyInstance[] = [];
const resources: ChainResources[] = [];

beforeAll(async () => {
  run = await openRunDatabase();
  config = {
    ...(await createTestConfig()),
    manifestKeyId: KEY_ID,
    manifestSigningKeyPem: PEM,
    downloadSecret: SECRET,
    manifestDrainIntervalSeconds: 3600,
  };
  storageRoot = await createRunStorageRoot();
  previousStorageRoot = process.env.GT_ADS_MEDIA_STORAGE_ROOT;
  process.env.GT_ADS_MEDIA_STORAGE_ROOT = storageRoot;
}, 180_000);

afterEach(async () => {
  for (const app of openApps.splice(0)) await app.close();
  for (const r of resources.splice(0)) await cleanupResources(run.pool, r, storageRoot).catch(() => undefined);
});

afterAll(async () => {
  if (previousStorageRoot === undefined) delete process.env.GT_ADS_MEDIA_STORAGE_ROOT;
  else process.env.GT_ADS_MEDIA_STORAGE_ROOT = previousStorageRoot;
  if (run !== undefined) await run.close();
  if (storageRoot !== "") await rm(storageRoot, { recursive: true, force: true });
}, 60_000);

/** Wie R-801 buildApp, aber ohne lokalen Download-Transport: die Produktivrouten liefern aus. */
async function openApp(): Promise<FastifyInstance> {
  const clock = createClock();
  const app = createServer({
    config,
    pool: run.pool,
    now: clock.now,
    logger: { level: "silent" },
    mediaUpload: {
      serviceOptions: { pool: run.pool, storageRoot },
      createMedia: (options, input) =>
        createMedia(options, {
          ...input,
          metadata: {
            container: "mp4", videoCodec: "h264", width: 1920, height: 1080,
            frameRateNumerator: 30, frameRateDenominator: 1, audioStreamCount: 0,
            durationSeconds: MEDIA_DURATION_SECONDS,
          },
        }),
    },
  });
  openApps.push(app);
  await app.ready();
  return app;
}

async function waitForManifest(app: FastifyInstance, headers: Record<string, string>): Promise<SignedManifestEnvelope> {
  for (let i = 0; i < 100; i++) {
    const response = await app.inject({ method: "GET", url: "/v1/device/manifest", headers, remoteAddress: "192.0.2.148" });
    if (response.statusCode === 200) return response.json() as SignedManifestEnvelope;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("CX-148: kein Manifest nach Kampagnenaktivierung erzeugt");
}

describe("CX-148 Auslieferung an die Tablets", () => {
  it("erzeugt das Manifest selbst und liefert Konfiguration, Freigabe und Medium aus", async () => {
    const app = await openApp();
    const admin = await loginAdmin(app);
    const res = createResources();
    resources.push(res);
    const device = await authenticateDevice(app, await registerDevice(app, admin, res, "SYN-CX148-Tablet-A"), "cx148-a");
    const second = await authenticateDevice(app, await registerDevice(app, admin, res, "SYN-CX148-Tablet-B"), "cx148-b");
    const headers = deviceHeaders(device);

    // Ohne Zuordnung: Konfiguration ohne Taxi, aber mit Manifestschluessel.
    const unassigned = await app.inject({ method: "GET", url: "/v1/device/config", headers, remoteAddress: "192.0.2.148" });
    expect(unassigned.statusCode).toBe(200);
    expect(unassigned.json()).toMatchObject({ taxi_id: null, downloads_available: true });

    const taxi = await createTaxi(run.pool, res, uniqueId("SYN-CX148-TAXI"), "SYN CX-148");
    await assignTablets(run.pool, taxi, device.deviceId, second.deviceId);
    const bytes = syntheticMp4();
    const upload = await uploadSyntheticMedia(app, admin, res, bytes);
    const customerId = await createCustomer(app, admin, res, "SYN-CX148-Kunde");
    await createActiveCampaign(app, admin, res, { customerId, mediaId: upload.id, taxiId: taxi.taxiId });

    // Konfiguration: Taxi und oeffentlicher Schluessel (SPKI, Base64) - so prueft die App.
    const configured = await app.inject({ method: "GET", url: "/v1/device/config", headers, remoteAddress: "192.0.2.148" });
    expect(configured.statusCode).toBe(200);
    const body = configured.json() as { taxi_id: string; manifest_key: { key_id: string; public_key_spki: string } };
    expect(body.taxi_id).toBe(taxi.taxiId);
    expect(body.manifest_key.key_id).toBe(KEY_ID);
    const publicKey = createPublicKey({ key: Buffer.from(body.manifest_key.public_key_spki, "base64"), format: "der", type: "spki" });
    expect(configured.body).not.toContain("PRIVATE");

    // Manifest entsteht ohne Testhilfe durch die verdrahtete Neuberechnung und ist mit dem gelieferten Schluessel pruefbar.
    const envelope = await waitForManifest(app, headers);
    const verified = verifySignedManifest(envelope, { taxiId: taxi.taxiId, environment: "test", trustedKeys: new Map([[KEY_ID, publicKey]]) });
    expect(verified.plan.taxiId).toBe(taxi.taxiId);

    // Freigabe nur fuer Medien des aktuellen Manifests.
    const grant = await app.inject({ method: "GET", url: "/v1/device/media/" + upload.id + "/grant", headers, remoteAddress: "192.0.2.148" });
    expect(grant.statusCode).toBe(200);
    const path = (grant.json() as { path: string }).path;
    expect(path.startsWith("/v1/device/downloads/" + upload.id + "?ticket=")).toBe(true);
    const unknown = await app.inject({ method: "GET", url: "/v1/device/media/00000000-0000-4000-8000-000000000148/grant", headers, remoteAddress: "192.0.2.148" });
    expect(unknown.statusCode).toBe(404);

    // Download: ganz, fortgesetzt (Range + If-Range) und mit manipuliertem Ticket abgewiesen.
    const full = await app.inject({ method: "GET", url: path, remoteAddress: "192.0.2.148" });
    expect(full.statusCode).toBe(200);
    expect(createHash("sha256").update(full.rawPayload).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
    const sha = createHash("sha256").update(bytes).digest("hex");
    const partial = await app.inject({ method: "GET", url: path, headers: { range: "bytes=10-", "if-range": '"' + sha + '"' }, remoteAddress: "192.0.2.148" });
    expect(partial.statusCode).toBe(206);
    expect(Buffer.compare(partial.rawPayload, bytes.subarray(10))).toBe(0);
    const tampered = await app.inject({ method: "GET", url: path.slice(0, -2) + "xx", remoteAddress: "192.0.2.148" });
    expect(tampered.statusCode).toBe(403);
    const wrongMedia = await app.inject({ method: "GET", url: path.replace(upload.id, "00000000-0000-4000-8000-000000000148"), remoteAddress: "192.0.2.148" });
    expect(wrongMedia.statusCode).toBe(403);
  }, 120_000);

  it("verlangt fuer Konfiguration und Freigabe die Geraeteanmeldung", async () => {
    const app = await openApp();
    for (const url of ["/v1/device/config", "/v1/device/media/00000000-0000-4000-8000-000000000148/grant"]) {
      const response = await app.inject({ method: "GET", url, remoteAddress: "192.0.2.148" });
      expect(response.statusCode).toBe(401);
    }
    const noTicket = await app.inject({ method: "GET", url: "/v1/device/downloads/00000000-0000-4000-8000-000000000148", remoteAddress: "192.0.2.148" });
    expect(noTicket.statusCode).toBe(403);
  }, 60_000);
});
