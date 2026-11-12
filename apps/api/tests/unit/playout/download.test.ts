import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildDownloadTicketMacMessage,
  DOWNLOAD_TICKET_DEFAULT_TTL_SECONDS,
  DOWNLOAD_TICKET_DOMAIN_PREFIX,
  DOWNLOAD_TICKET_MAX_TTL_SECONDS,
  DOWNLOAD_TICKET_MIN_TTL_SECONDS,
  DOWNLOAD_TICKET_SCHEMA_VERSION,
  DownloadError,
  issueDownloadTicket,
  processDownloadRequest,
  serializeDownloadTicketPayload,
  verifyDownloadTicket,
  type DeviceTaxiBinding,
  type DownloadAuthorizationAdapter,
  type DownloadAuthorizationRequest,
  type DownloadErrorCode,
  type DownloadMediaRecord,
  type DownloadMediaSource,
  type DownloadResult,
  type IssueDownloadTicketInput,
  type IssuedDownloadTicket,
  type ProcessDownloadRequestInput,
} from "../../../src/modules/playout/download.js";
import {
  createSignedManifest,
  verifySignedManifest,
  type VerifiedManifest,
} from "../../../src/modules/playout/manifest.js";
import {
  buildLoopPlan,
  SPOT_DURATION_MS,
} from "../../../src/modules/playout/planner.js";
import type {
  LoopPlan,
  LoopPlanCampaign,
  LoopPlanPlacement,
} from "../../../src/modules/playout/types.js";

const TAXI_ID = "taxi-cx008";
const DEVICE_ID = "device-cx008";
const OTHER_DEVICE_ID = "device-cx008-other";
const MEDIA_ID = "media-cx008";
const SECRET = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const NOW = new Date("2026-11-12T08:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);

const SIGNING_KEYS = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const KEY_ID = "download-test-key";

// Reale synthetische Bytefolge; kein Mock-Hash und keine Zufallsbytes.
const MEDIA_BYTES = Buffer.from(
  Array.from({ length: 1_024 }, (_, index) => (index * 73 + 19) % 256),
);
const MEDIA_SHA = sha256(MEDIA_BYTES);

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function createClock(initial: Date) {
  let milliseconds = initial.getTime();

  return {
    clock: (): Date => new Date(milliseconds),
    advanceSeconds(seconds: number): void {
      milliseconds += seconds * 1_000;
    },
  };
}

function allowedBinding(): DeviceTaxiBinding {
  return { deviceId: DEVICE_ID, taxiId: TAXI_ID, authorized: true };
}

function buildVerifiedManifest(
  media: { mediaId: string; sha256: string; sizeBytes: number } = {
    mediaId: MEDIA_ID,
    sha256: MEDIA_SHA,
    sizeBytes: MEDIA_BYTES.byteLength,
  },
): VerifiedManifest {
  const campaign: LoopPlanCampaign = {
    campaignId: "campaign-cx008",
    status: "active",
    startAt: "2099-03-01T10:00:00.000Z",
    endAt: "2099-03-02T10:00:00.000Z",
    targetTaxiIds: [TAXI_ID],
    targetGroupIds: [],
  };

  const placements: LoopPlanPlacement[] = Array.from(
    { length: 12 },
    (_, index) => ({
      position: index + 1,
      campaignId: campaign.campaignId,
      media: {
        mediaId: media.mediaId,
        sha256: media.sha256,
        sizeBytes: media.sizeBytes,
        durationMs: SPOT_DURATION_MS,
      },
    }),
  );

  const plan: LoopPlan = buildLoopPlan({
    taxiId: TAXI_ID,
    groupIds: [],
    slotCount: 12,
    campaigns: [campaign],
    placements,
  });

  const envelope = createSignedManifest({
    plan,
    environment: "test",
    keyId: KEY_ID,
    signingKey: SIGNING_KEYS.privateKey,
  });

  return verifySignedManifest(envelope, {
    taxiId: TAXI_ID,
    environment: "test",
    trustedKeys: new Map([[KEY_ID, SIGNING_KEYS.publicKey]]),
  });
}

const GOOD_MANIFEST = buildVerifiedManifest();

function issueTicket(
  overrides: Partial<IssueDownloadTicketInput> = {},
): IssuedDownloadTicket {
  return issueDownloadTicket({
    deviceId: DEVICE_ID,
    deviceTaxiBinding: allowedBinding(),
    manifest: GOOD_MANIFEST,
    mediaId: MEDIA_ID,
    secret: SECRET,
    clock: () => NOW,
    ...overrides,
  });
}

function sourceFor(
  overrides: Partial<DownloadMediaRecord> = {},
  bytes: Uint8Array = MEDIA_BYTES,
): DownloadMediaSource {
  return {
    read: async (mediaId: string): Promise<DownloadMediaRecord | null> => {
      if (mediaId !== MEDIA_ID) {
        return null;
      }
      return {
        sha256: MEDIA_SHA,
        sizeBytes: bytes.byteLength,
        content: bytes,
        ...overrides,
      };
    },
  };
}

const allowAll: DownloadAuthorizationAdapter = { authorize: () => true };
const denyAll: DownloadAuthorizationAdapter = { authorize: () => false };

function handle(
  ticket: IssuedDownloadTicket,
  overrides: Partial<ProcessDownloadRequestInput> = {},
): Promise<DownloadResult> {
  return processDownloadRequest({
    ticket: ticket.ticket,
    deviceId: DEVICE_ID,
    secret: SECRET,
    clock: () => NOW,
    authorization: allowAll,
    mediaSource: sourceFor(),
    ...overrides,
  });
}

function expectDownloadError(
  run: () => unknown,
  code: DownloadErrorCode,
): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DownloadError);
    expect((error as DownloadError).code).toBe(code);
    return;
  }

  throw new Error(`Erwarteter DownloadError ${code} wurde nicht geworfen.`);
}

function expectNoBytes(result: DownloadResult): void {
  expect(result.bytes).toHaveLength(0);
}

describe("CX-008 Ticket-Ausstellung", () => {
  it("erzeugt kanonisches Base64url mit fester Feldreihenfolge und echtem HMAC", () => {
    const grant = issueTicket();

    expect(grant.payload).toEqual({
      schemaVersion: DOWNLOAD_TICKET_SCHEMA_VERSION,
      deviceId: DEVICE_ID,
      taxiId: TAXI_ID,
      manifestVersion: GOOD_MANIFEST.version,
      mediaId: MEDIA_ID,
      sha256: MEDIA_SHA,
      expiresAt: NOW_SECONDS + DOWNLOAD_TICKET_DEFAULT_TTL_SECONDS,
    });

    expect(grant.ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(grant.ticket).not.toContain("=");
    expect(grant.query).toBe(
      `ticket=${encodeURIComponent(grant.ticket)}`,
    );

    const decoded = Buffer.from(grant.encodedPayload, "base64url").toString(
      "utf8",
    );
    expect(decoded).toBe(serializeDownloadTicketPayload(grant.payload));
    expect(
      (JSON.parse(decoded) as Record<string, unknown>).constructor,
    ).toBe(Object);
    expect(Object.keys(JSON.parse(decoded) as Record<string, unknown>)).toEqual([
      "schemaVersion",
      "deviceId",
      "taxiId",
      "manifestVersion",
      "mediaId",
      "sha256",
      "expiresAt",
    ]);

    const expectedMac = createHmac("sha256", SECRET)
      .update(
        `${DOWNLOAD_TICKET_DOMAIN_PREFIX}\n${grant.encodedPayload}`,
        "utf8",
      )
      .digest("base64url");
    expect(buildDownloadTicketMacMessage(grant.encodedPayload)).toBe(
      `${DOWNLOAD_TICKET_DOMAIN_PREFIX}\n${grant.encodedPayload}`,
    );
    expect(grant.mac).toBe(expectedMac);

    expect(
      verifyDownloadTicket({
        ticket: grant.ticket,
        secret: SECRET,
        clock: () => NOW,
      }),
    ).toEqual(grant.payload);
  });

  it("nutzt 300 Sekunden als Standard und erlaubt ausschließlich 1 bis 900", () => {
    expect(issueTicket().payload.expiresAt).toBe(NOW_SECONDS + 300);
    expect(
      issueTicket({ ttlSeconds: DOWNLOAD_TICKET_MIN_TTL_SECONDS }).payload
        .expiresAt,
    ).toBe(NOW_SECONDS + 1);
    expect(
      issueTicket({ ttlSeconds: 42 }).payload.expiresAt,
    ).toBe(NOW_SECONDS + 42);
    expect(
      issueTicket({ ttlSeconds: DOWNLOAD_TICKET_MAX_TTL_SECONDS }).payload
        .expiresAt,
    ).toBe(NOW_SECONDS + 900);

    for (const ttl of [0, 901, 1.5, Number.NaN]) {
      expectDownloadError(() => issueTicket({ ttlSeconds: ttl }), "invalid_ttl");
    }
  });

  it("weist zu kurze, fehlende und fremde Schlüssel ab und verlangt 32 Byte", () => {
    expectDownloadError(
      () => issueTicket({ secret: Buffer.alloc(31, 7) }),
      "invalid_secret",
    );
    expectDownloadError(
      () => issueTicket({ secret: Buffer.alloc(0, 7) }),
      "invalid_secret",
    );
    expectDownloadError(
      () => issueTicket({ secret: undefined as unknown as Uint8Array }),
      "invalid_secret",
    );

    const exactly32 = Buffer.alloc(32, 7);
    expect(issueTicket({ secret: exactly32 }).payload.expiresAt).toBe(
      NOW_SECONDS + 300,
    );
  });

  it("verlangt geprüftes Manifest, autorisierte Bindung und Medium im Manifest", () => {
    expectDownloadError(
      () =>
        issueTicket({
          deviceTaxiBinding: {
            deviceId: DEVICE_ID,
            taxiId: TAXI_ID,
            authorized: false,
          },
        }),
      "device_binding_not_authorized",
    );

    expectDownloadError(
      () =>
        issueTicket({
          deviceTaxiBinding: {
            deviceId: DEVICE_ID,
            taxiId: "taxi-fremd",
            authorized: true,
          },
        }),
      "device_binding_not_authorized",
    );

    expectDownloadError(
      () =>
        issueTicket({
          deviceTaxiBinding: {
            deviceId: OTHER_DEVICE_ID,
            taxiId: TAXI_ID,
            authorized: true,
          },
        }),
      "device_binding_not_authorized",
    );

    expectDownloadError(
      () => issueTicket({ mediaId: "media-not-in-manifest" }),
      "media_not_in_manifest",
    );

    expectDownloadError(
      () =>
        issueTicket({
          manifest: {
            ...GOOD_MANIFEST,
            version: "kein-sha256",
          },
        }),
      "invalid_manifest_version",
    );
  });
});

describe("CX-008 Ticket-Prüfung und Autorisierung", () => {
  it("weist Manipulation, Ablauf exakt bei expiresAt und falsches Gerät ab", async () => {
    const clock = createClock(NOW);
    const grant = issueTicket({ clock: clock.clock, ttlSeconds: 10 });

    const tamperedMac =
      grant.mac.slice(0, -1) + (grant.mac.endsWith("A") ? "B" : "A");
    expectDownloadError(
      () =>
        verifyDownloadTicket({
          ticket: `${grant.encodedPayload}.${tamperedMac}`,
          secret: SECRET,
          clock: clock.clock,
        }),
      "invalid_mac",
    );

    const flippedPayload =
      grant.encodedPayload.slice(0, -1) +
      (grant.encodedPayload.endsWith("A") ? "B" : "A");
    expectDownloadError(
      () =>
        verifyDownloadTicket({
          ticket: `${flippedPayload}.${grant.mac}`,
          secret: SECRET,
          clock: clock.clock,
        }),
      "invalid_mac",
    );

    clock.advanceSeconds(9);
    expect(
      verifyDownloadTicket({
        ticket: grant.ticket,
        secret: SECRET,
        clock: clock.clock,
      }).expiresAt,
    ).toBe(NOW_SECONDS + 10);

    clock.advanceSeconds(1);
    expectDownloadError(
      () =>
        verifyDownloadTicket({
          ticket: grant.ticket,
          secret: SECRET,
          clock: clock.clock,
        }),
      "expired_ticket",
    );

    const expired = await handle(grant, { clock: clock.clock });
    expect(expired.status).toBe(403);
    expect(expired.error).toBe("expired_ticket");
    expectNoBytes(expired);

    const wrongDevice = await handle(grant, { deviceId: OTHER_DEVICE_ID });
    expect(wrongDevice.status).toBe(403);
    expect(wrongDevice.error).toBe("device_mismatch");
    expectNoBytes(wrongDevice);
  });

  it("verweigert fehlenden/verweigernden Adapter und widerrufene Geräte ohne Bytes", async () => {
    const grant = issueTicket();

    const missingAdapter = await handle(grant, { authorization: undefined });
    expect(missingAdapter.status).toBe(403);
    expect(missingAdapter.error).toBe("authorization_unavailable");
    expectNoBytes(missingAdapter);

    const denied = await handle(grant, { authorization: denyAll });
    expect(denied.status).toBe(403);
    expect(denied.error).toBe("authorization_denied");
    expectNoBytes(denied);

    let currentlyAllowed = true;
    const requests: DownloadAuthorizationRequest[] = [];
    const adapter: DownloadAuthorizationAdapter = {
      authorize: (request) => {
        requests.push(request);
        return currentlyAllowed;
      },
    };

    const allowed = await handle(grant, { authorization: adapter });
    expect(allowed.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      deviceId: DEVICE_ID,
      taxiId: TAXI_ID,
      manifestVersion: GOOD_MANIFEST.version,
      mediaId: MEDIA_ID,
      sha256: MEDIA_SHA,
    });

    currentlyAllowed = false;
    const revoked = await handle(grant, { authorization: adapter });
    expect(revoked.status).toBe(403);
    expect(revoked.error).toBe("authorization_denied");
    expectNoBytes(revoked);

    const throwing: DownloadAuthorizationAdapter = {
      authorize: () => {
        throw new Error("Gerät widerrufen");
      },
    };
    const thrown = await handle(grant, { authorization: throwing });
    expect(thrown.status).toBe(403);
    expect(thrown.error).toBe("authorization_denied");
    expectNoBytes(thrown);
  });
});

describe("CX-008 Download und Byte-Ranges", () => {
  it("liefert ohne Range alle Bytes mit 200 und starkem ETag", async () => {
    const grant = issueTicket();
    const result = await handle(grant);

    expect(result.status).toBe(200);
    expect(result.error).toBeUndefined();
    expect(result.headers).toEqual({
      ETag: `"${MEDIA_SHA}"`,
      "Accept-Ranges": "bytes",
      "Content-Length": "1024",
    });
    expect(Buffer.from(result.bytes).equals(MEDIA_BYTES)).toBe(true);
  });

  it("liefert geschlossene, offene und Suffix-Range bytegenau als 206", async () => {
    const grant = issueTicket();

    const closed = await handle(grant, { rangeHeader: "bytes=10-19" });
    expect(closed.status).toBe(206);
    expect(closed.headers).toEqual({
      ETag: `"${MEDIA_SHA}"`,
      "Accept-Ranges": "bytes",
      "Content-Length": "10",
      "Content-Range": "bytes 10-19/1024",
    });
    expect(Buffer.from(closed.bytes).equals(MEDIA_BYTES.subarray(10, 20))).toBe(
      true,
    );

    const open = await handle(grant, { rangeHeader: "bytes=1000-" });
    expect(open.status).toBe(206);
    expect(open.headers["Content-Range"]).toBe("bytes 1000-1023/1024");
    expect(open.headers["Content-Length"]).toBe("24");
    expect(
      Buffer.from(open.bytes).equals(MEDIA_BYTES.subarray(1000, 1024)),
    ).toBe(true);

    const suffix = await handle(grant, { rangeHeader: "bytes=-16" });
    expect(suffix.status).toBe(206);
    expect(suffix.headers["Content-Range"]).toBe("bytes 1008-1023/1024");
    expect(suffix.headers["Content-Length"]).toBe("16");
    expect(
      Buffer.from(suffix.bytes).equals(MEDIA_BYTES.subarray(1008, 1024)),
    ).toBe(true);

    const clamped = await handle(grant, { rangeHeader: "bytes=1000-99999" });
    expect(clamped.status).toBe(206);
    expect(clamped.headers["Content-Range"]).toBe("bytes 1000-1023/1024");
  });

  it("setzt zwei Teilabrufe exakt zu Originalbytes und SHA-256 zusammen", async () => {
    const grant = issueTicket();

    const first = await handle(grant, { rangeHeader: "bytes=0-511" });
    const second = await handle(grant, { rangeHeader: "bytes=512-1023" });

    expect(first.status).toBe(206);
    expect(second.status).toBe(206);
    const combined = Buffer.concat([
      Buffer.from(first.bytes),
      Buffer.from(second.bytes),
    ]);

    expect(combined.equals(MEDIA_BYTES)).toBe(true);
    expect(sha256(combined)).toBe(MEDIA_SHA);
    expect(first.headers["Content-Length"]).toBe("512");
    expect(second.headers["Content-Length"]).toBe("512");
  });

  it("meldet nicht erfüllbare Ranges mit 416 und bytes */N", async () => {
    const grant = issueTicket();

    for (const header of ["bytes=1024-", "bytes=2000-3000", "bytes=-0"]) {
      const result = await handle(grant, { rangeHeader: header });
      expect(result.status).toBe(416);
      expect(result.headers["Content-Range"]).toBe("bytes */1024");
      expect(result.headers["Content-Length"]).toBe("0");
      expect(result.error).toBe("unsatisfiable_range");
      expectNoBytes(result);
    }
  });

  it("weist Mehrfachbereiche und ungültige Range-Syntax kontrolliert mit 400 ab", async () => {
    const grant = issueTicket();

    const multiple = await handle(grant, { rangeHeader: "bytes=0-1,3-4" });
    expect(multiple.status).toBe(400);
    expect(multiple.error).toBe("multiple_ranges");
    expectNoBytes(multiple);

    const spacedMultiple = await handle(grant, {
      rangeHeader: "bytes=0-1, 3-4",
    });
    expect(spacedMultiple.status).toBe(400);
    expect(spacedMultiple.error).toBe("multiple_ranges");
    expectNoBytes(spacedMultiple);

    for (const header of [
      "bytes=abc",
      "bytes=5-4",
      "bytes=1-2-3",
      "bytes=",
      "items=0-1",
      "bytes=--",
    ]) {
      const result = await handle(grant, { rangeHeader: header });
      expect(result.status).toBe(400);
      expect(result.error).toBe("invalid_range");
      expectNoBytes(result);
    }
  });

  it("wertet If-Range nur als exakten starken ETag-Vergleich aus", async () => {
    const grant = issueTicket();
    const etag = `"${MEDIA_SHA}"`;

    const matching = await handle(grant, {
      rangeHeader: "bytes=0-9",
      ifRangeHeader: etag,
    });
    expect(matching.status).toBe(206);
    expect(matching.headers["Content-Range"]).toBe("bytes 0-9/1024");

    const different = await handle(grant, {
      rangeHeader: "bytes=0-9",
      ifRangeHeader: `"${"0".repeat(64)}"`,
    });
    expect(different.status).toBe(200);
    expect(different.headers["Content-Length"]).toBe("1024");
    expect(Buffer.from(different.bytes).equals(MEDIA_BYTES)).toBe(true);

    const weak = await handle(grant, {
      rangeHeader: "bytes=0-9",
      ifRangeHeader: `W/${etag}`,
    });
    expect(weak.status).toBe(200);
    expect(Buffer.from(weak.bytes).equals(MEDIA_BYTES)).toBe(true);

    const dateValue = await handle(grant, {
      rangeHeader: "bytes=0-9",
      ifRangeHeader: "Wed, 21 Oct 2015 07:28:00 GMT",
    });
    expect(dateValue.status).toBe(200);
    expect(Buffer.from(dateValue.bytes).equals(MEDIA_BYTES)).toBe(true);
  });

  it("liefert bei fehlenden Medien, Metadaten- oder Digest-Abweichungen keine Bytes", async () => {
    const grant = issueTicket();

    const missing = await handle(grant, {
      mediaSource: { read: async () => null },
    });
    expect(missing.status).toBe(404);
    expect(missing.error).toBe("media_not_found");
    expectNoBytes(missing);

    const missingSource = await handle(grant, { mediaSource: undefined });
    expect(missingSource.status).toBe(404);
    expect(missingSource.error).toBe("media_unavailable");
    expectNoBytes(missingSource);

    const metadataMismatch = await handle(grant, {
      mediaSource: sourceFor({ sha256: "f".repeat(64) }),
    });
    expect(metadataMismatch.status).toBe(409);
    expect(metadataMismatch.error).toBe("media_metadata_mismatch");
    expectNoBytes(metadataMismatch);

    const altered = Buffer.from(MEDIA_BYTES);
    altered[0] = altered[0] ^ 0xff;
    const digestMismatch = await handle(grant, {
      mediaSource: sourceFor({ sha256: MEDIA_SHA, sizeBytes: 1_024 }, altered),
    });
    expect(digestMismatch.status).toBe(409);
    expect(digestMismatch.error).toBe("digest_mismatch");
    expectNoBytes(digestMismatch);

    const sizeMismatch = await handle(grant, {
      mediaSource: sourceFor({ sha256: MEDIA_SHA, sizeBytes: 999 }),
    });
    expect(sizeMismatch.status).toBe(409);
    expect(sizeMismatch.error).toBe("size_mismatch");
    expectNoBytes(sizeMismatch);
  });

  it("weist Medien außerhalb des Manifests und abweichende Manifest-Metadaten ab", async () => {
    expectDownloadError(
      () => issueTicket({ mediaId: "media-ausserhalb" }),
      "media_not_in_manifest",
    );

    const wrongHashManifest = buildVerifiedManifest({
      mediaId: MEDIA_ID,
      sha256: "0".repeat(64),
      sizeBytes: 1_024,
    });
    const wrongHashTicket = issueTicket({ manifest: wrongHashManifest });
    const wrongHash = await handle(wrongHashTicket, {
      mediaSource: sourceFor({
        sha256: "0".repeat(64),
        sizeBytes: 1_024,
      }),
    });
    expect(wrongHash.status).toBe(409);
    expect(wrongHash.error).toBe("digest_mismatch");
    expectNoBytes(wrongHash);

    const wrongSizeManifest = buildVerifiedManifest({
      mediaId: MEDIA_ID,
      sha256: MEDIA_SHA,
      sizeBytes: 999,
    });
    const wrongSizeTicket = issueTicket({ manifest: wrongSizeManifest });
    const wrongSize = await handle(wrongSizeTicket, {
      mediaSource: sourceFor({ sha256: MEDIA_SHA, sizeBytes: 999 }),
    });
    expect(wrongSize.status).toBe(409);
    expect(wrongSize.error).toBe("size_mismatch");
    expectNoBytes(wrongSize);
  });
});

