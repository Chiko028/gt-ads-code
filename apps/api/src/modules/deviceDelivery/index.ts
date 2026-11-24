/**
 * CX-148: Verdrahtung der Auslieferungskette an die Tablets.
 *
 * Die Fachbausteine existieren bereits und bleiben unveraendert:
 *   - CX-041 ManifestRefreshService erzeugt und signiert Manifeste je Taxi,
 *   - CX-042 liest das aktuelle Artefakt (GET /v1/device/manifest),
 *   - CX-008 stellt Download-Tickets aus und liefert Bytes fortsetzbar aus.
 * Dieses Modul baut nur noch zusammen:
 *   1. ManifestRefreshService aus der Serverkonfiguration (Signierschluessel),
 *   2. GET /v1/device/config      -> Taxi-Kennung und oeffentlicher Manifestschluessel,
 *   3. GET /v1/device/media/:id/grant -> kurzlebiger Downloadpfad mit Ticket,
 *   4. GET /v1/device/downloads/:id   -> Bytes (Ticket + Range/If-Range, CX-008).
 * Geheimnisse (privater Schluessel, Download-Secret) verlassen den Prozess nie.
 */
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../../config.js";
import { ApiError } from "../../http/errors.js";
import { createDeviceAuthMiddleware } from "../deviceAuth/middleware.js";
import type { DeviceAuthService } from "../deviceAuth/service.js";
import { createSqlDeviceManifestReader, type DeviceManifestReader } from "../deviceManifest/reader.js";
import { ManifestRefreshService } from "../manifestRefresh/index.js";
import { getReadyMediaFile } from "../media/service.js";
import { isMediaId } from "../media/storage.js";
import type { MediaServiceOptions } from "../media/types.js";
import {
  DownloadError,
  issueDownloadTicket,
  processDownloadRequest,
  verifyDownloadTicket,
  type DownloadMediaSource,
} from "../playout/download.js";
import { verifySignedManifest, type ManifestEnvironment } from "../playout/manifest.js";

export const DEVICE_CONFIG_PATH = "/v1/device/config";
export const DEVICE_MEDIA_GRANT_PATH = "/v1/device/media/:id/grant";
export const DEVICE_DOWNLOAD_PATH = "/v1/device/downloads/:id";
const DOWNLOAD_PATH_PREFIX = "/v1/device/downloads/";

/** Oeffentlicher Teil der Manifestsignatur; der private Schluessel bleibt im Prozess. */
export interface ManifestKeyMaterial {
  keyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** SPKI-DER, Base64 (Standard, mit Padding) - so prueft die App (CX-073). */
  publicKeySpkiBase64: string;
}

/** Liest den Signierschluessel (PKCS#8-PEM, EC P-256); null, wenn nicht konfiguriert. */
export function manifestKeyFromConfig(config: AppConfig): ManifestKeyMaterial | null {
  if (!config.manifestKeyId || !config.manifestSigningKeyPem) return null;
  const privateKey = createPrivateKey({ key: config.manifestSigningKeyPem, format: "pem" });
  if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("GT_ADS_MANIFEST_SIGNING_KEY_FILE muss ein EC-P-256-Schluessel sein");
  }
  const publicKey = createPublicKey(privateKey);
  return {
    keyId: config.manifestKeyId,
    privateKey,
    publicKey,
    publicKeySpkiBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

/** Manifest-Erzeugung (CX-041) mit dem konfigurierten Schluessel; null ohne Schluessel. */
export function createManifestRefresh(
  pool: Pool,
  config: AppConfig,
  key: ManifestKeyMaterial | null,
  now?: () => Date,
): ManifestRefreshService | null {
  if (key === null) return null;
  return new ManifestRefreshService({
    pool,
    signingKey: key.privateKey,
    keyId: key.keyId,
    environment: config.env as ManifestEnvironment,
    trustedKeys: new Map([[key.keyId, key.publicKey]]),
    fallbackMediaId: config.fallbackMediaId ?? null,
    ...(now ? { now } : {}),
  });
}

/**
 * Regelmaessiger, begrenzter Lauf fuer offene Taxis (z. B. nach Zuordnungsaenderungen ohne
 * eigenen Ausloeser). Laeufe ueberlappen nie; Fehler bleiben im Dienst (Status je Taxi).
 */
export function startManifestDrain(app: FastifyInstance, service: ManifestRefreshService, intervalMs: number): void {
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    service
      .drainPending({ limit: 25 })
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  app.addHook("onReady", async () => {
    tick();
  });
  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
}

export interface DeviceDeliveryDeps {
  pool: Pool;
  deviceAuth: DeviceAuthService;
  key: ManifestKeyMaterial | null;
  downloadSecret: string | null;
  mediaOptions: MediaServiceOptions;
  now?: () => Date;
  /** Fuer Tests injizierbar; Standard ist der vorhandene CX-042-Leser. */
  reader?: DeviceManifestReader;
}

/**
 * Medienquelle fuer CX-008: nur fertige Medien aus dem lokalen Speicher.
 * L-01 (bis 1000 MB): kein Volllesen und kein Hash je Anfrage; ausgeliefert
 * wird nur der angefragte Bereich als Strom. Das Geraet prueft SHA-256 nach
 * dem vollstaendigen Download selbst.
 */
function mediaSource(options: MediaServiceOptions): DownloadMediaSource {
  return {
    async read(mediaId: string) {
      if (!isMediaId(mediaId)) return null;
      const media = await getReadyMediaFile(options, mediaId).catch(() => null);
      if (media === null || media === undefined) return null;
      return { sha256: media.sha256, sizeBytes: media.sizeBytes, openRange: media.openRange };
    },
  };
}

export function registerDeviceDeliveryRoutes(app: FastifyInstance, deps: DeviceDeliveryDeps): void {
  const reader = deps.reader ?? createSqlDeviceManifestReader(deps.pool);
  const auth = createDeviceAuthMiddleware(deps.deviceAuth);
  const clock = (): Date => (deps.now ? deps.now() : new Date());

  /** Taxi der authentifizierten Geraete-ID oder null (keine/inaktive Zuordnung). */
  async function taxiOf(deviceId: string): Promise<string | null> {
    const assignment = await reader.findAssignment(deviceId);
    return assignment !== null && assignment.active ? assignment.taxiId : null;
  }

  // Ohne Signierschluessel bzw. Download-Geheimnis werden die Routen nicht registriert
  // (Verhalten wie vor CX-148; Testkompositionen koennen eigene Transporte nutzen).
  if (deps.key !== null) registerConfigAndGrant();
  if (deps.downloadSecret !== null) registerDownload();

  function registerConfigAndGrant(): void {
  app.get(DEVICE_CONFIG_PATH, { preHandler: auth }, async (request, reply) => {
    const context = request.deviceAuth;
    if (context === undefined) throw ApiError.unauthorized();
    const taxiId = await taxiOf(context.deviceId);
    reply.header("Cache-Control", "no-store");
    return reply.code(200).send({
      taxi_id: taxiId,
      manifest_key: deps.key === null ? null : { key_id: deps.key.keyId, public_key_spki: deps.key.publicKeySpkiBase64 },
      downloads_available: deps.downloadSecret !== null,
    });
  });

  app.get(DEVICE_MEDIA_GRANT_PATH, { preHandler: auth }, async (request, reply) => {
    const context = request.deviceAuth;
    if (context === undefined) throw ApiError.unauthorized();
    const mediaId = String((request.params as { id?: unknown }).id ?? "").toLowerCase();
    if (deps.key === null || deps.downloadSecret === null || !isMediaId(mediaId)) throw ApiError.notFound();
    const taxiId = await taxiOf(context.deviceId);
    if (taxiId === null) throw ApiError.notFound();
    const artifact = await reader.getCurrentArtifact(taxiId);
    if (artifact === null) throw ApiError.notFound();
    let ticket;
    try {
      const manifest = verifySignedManifest(artifact.envelope, {
        taxiId,
        environment: artifact.environment,
        trustedKeys: new Map([[deps.key.keyId, deps.key.publicKey]]),
      });
      ticket = issueDownloadTicket({
        deviceId: context.deviceId,
        deviceTaxiBinding: { deviceId: context.deviceId, taxiId, authorized: true },
        manifest,
        mediaId,
        secret: deps.downloadSecret,
        clock,
      });
    } catch (error) {
      // Medium nicht im aktuellen Manifest oder Artefakt nicht pruefbar: wie unbekannt.
      if (error instanceof DownloadError) throw ApiError.notFound();
      throw ApiError.notFound();
    }
    reply.header("Cache-Control", "no-store");
    return reply.code(200).send({ path: DOWNLOAD_PATH_PREFIX + mediaId + "?" + ticket.query });
  });

  }

  function registerDownload(): void {
  app.get(DEVICE_DOWNLOAD_PATH, async (request, reply) => {
    const mediaId = String((request.params as { id?: unknown }).id ?? "").toLowerCase();
    const ticketRaw = (request.query as { ticket?: unknown }).ticket;
    if (deps.downloadSecret === null || typeof ticketRaw !== "string" || ticketRaw.length === 0) {
      throw ApiError.forbidden();
    }
    let deviceId: string;
    try {
      const payload = verifyDownloadTicket({ ticket: ticketRaw, secret: deps.downloadSecret, clock });
      if (payload.mediaId !== mediaId) throw ApiError.forbidden();
      deviceId = payload.deviceId;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw ApiError.forbidden();
    }
    const result = await processDownloadRequest({
      ticket: ticketRaw,
      deviceId,
      secret: deps.downloadSecret,
      clock,
      // Zum Abrufzeitpunkt: Geraet weiterhin aktiv dem Taxi zugeordnet und Manifestversion noch aktuell.
      authorization: {
        async authorize(req) {
          const device = await deps.pool.query<{ state: string }>("select state from devices where id = $1::uuid", [req.deviceId]);
          if (device.rows[0]?.state !== "active") return false; // widerrufene Geraete laden nichts mehr
          if ((await taxiOf(req.deviceId)) !== req.taxiId) return false;
          const artifact = await reader.getCurrentArtifact(req.taxiId);
          return artifact !== null && artifact.version === req.manifestVersion;
        },
      },
      mediaSource: mediaSource(deps.mediaOptions),
      rangeHeader: typeof request.headers.range === "string" ? request.headers.range : null,
      ifRangeHeader: typeof request.headers["if-range"] === "string" ? request.headers["if-range"] : null,
    });
    for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
    reply.header("Cache-Control", "no-store");
    if (result.stream !== undefined) return reply.code(result.status).send(result.stream);
    return reply.code(result.status).send(Buffer.from(result.bytes));
  });
  }
}
