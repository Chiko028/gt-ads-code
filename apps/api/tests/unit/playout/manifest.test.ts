import {
  createHash,
  generateKeyPairSync,
  sign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildManifestSignatureMessage,
  createSignedManifest,
  MANIFEST_MAX_PAYLOAD_BYTES,
  ManifestError,
  verifySignedManifest,
  type ManifestEnvironment,
  type ManifestErrorCode,
  type SignedManifestEnvelope,
  type VerifySignedManifestExpectations,
} from "../../../src/modules/playout/manifest.js";
import {
  buildLoopPlan,
  SPOT_DURATION_MS,
} from "../../../src/modules/playout/planner.js";
import type {
  LoopPlan,
  LoopPlanCampaign,
  LoopPlanInput,
  LoopPlanMedia,
  LoopPlanPlacement,
} from "../../../src/modules/playout/types.js";

const TAXI_ID = "taxi-001";
const GROUP_A = "group-a";
const KEY_ID = "signing-key_2026-11";
const VALID_START = "2099-03-01T10:00:00.000Z";
const VALID_END = "2099-03-02T10:00:00.000Z";

// Schlüssel ausschließlich im Test erzeugt; keine Wiederverwendung von
// Geräteschlüsseln und keine gemockten Signaturergebnisse.
const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const otherKeyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

function sha256HexFor(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

function sha256Hex(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeMedia(seed: number): LoopPlanMedia {
  return {
    mediaId: `media-${seed}`,
    sha256: sha256HexFor(seed),
    sizeBytes: 1_000_000 + seed,
    durationMs: SPOT_DURATION_MS,
  };
}

function makeCampaign(seed: number): LoopPlanCampaign {
  return {
    campaignId: `campaign-${seed}`,
    status: "active",
    startAt: VALID_START,
    endAt: VALID_END,
    targetTaxiIds: [TAXI_ID],
    targetGroupIds: [],
  };
}

type MutableLoopPlanInput = Omit<LoopPlanInput, "campaigns" | "placements"> & {
  campaigns: LoopPlanCampaign[];
  placements: LoopPlanPlacement[];
};

function makeInput(slotCount: number = 12): MutableLoopPlanInput {
  const campaigns = Array.from({ length: slotCount }, (_, index) =>
    makeCampaign(index + 1),
  );
  const placements = campaigns.map((campaign, index) => ({
    position: index + 1,
    campaignId: campaign.campaignId,
    media: makeMedia(index + 1),
  }));

  return {
    taxiId: TAXI_ID,
    groupIds: [GROUP_A],
    slotCount,
    campaigns,
    placements,
  };
}

function createEnvelope(
  plan: LoopPlan,
  environment: ManifestEnvironment = "test",
): SignedManifestEnvelope {
  return createSignedManifest({
    plan,
    environment,
    keyId: KEY_ID,
    signingKey: keyPair.privateKey,
  });
}

function expectations(
  overrides: Partial<VerifySignedManifestExpectations> = {},
): VerifySignedManifestExpectations {
  return {
    taxiId: TAXI_ID,
    environment: "test",
    trustedKeys: new Map<string, KeyObject>([[KEY_ID, keyPair.publicKey]]),
    ...overrides,
  };
}

function expectManifestError(
  action: () => unknown,
  code: ManifestErrorCode,
): ManifestError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestError);
    const manifestError = error as ManifestError;
    expect(manifestError.code).toBe(code);
    return manifestError;
  }

  throw new Error(`Erwartet wurde ein ManifestError mit Code "${code}".`);
}

/**
 * Signiert eine beliebige Nutzlast mit dem echten Testschlüssel. Nur so lassen
 * sich Schemafehler prüfen, ohne die Signaturprüfung zu umgehen.
 */
function signRawPayload(payloadJson: string): SignedManifestEnvelope {
  const payloadBytes = Buffer.from(payloadJson, "utf8");
  const payloadBase64 = payloadBytes.toString("base64");
  const version = sha256Hex(payloadBytes);
  const message = buildManifestSignatureMessage(
    KEY_ID,
    version,
    payloadBase64,
  );
  const signatureBase64 = sign(
    "sha256",
    Buffer.from(message, "utf8"),
    { key: keyPair.privateKey, dsaEncoding: "der" },
  ).toString("base64");

  return {
    schemaVersion: 1,
    keyId: KEY_ID,
    version,
    payloadBase64,
    signatureBase64,
  };
}

describe("Determinismus und Inhaltsversion", () => {
  it("erzeugt für identische Pläne byteidentische Nutzlast und identische Inhaltsversion", () => {
    const plan = buildLoopPlan(makeInput());
    const first = createEnvelope(plan);
    const second = createEnvelope(plan);

    expect(first.payloadBase64).toBe(second.payloadBase64);
    expect(first.version).toBe(second.version);
    expect(first.version).toMatch(/^[0-9a-f]{64}$/);
    expect(
      Buffer.from(first.payloadBase64, "base64").equals(
        Buffer.from(second.payloadBase64, "base64"),
      ),
    ).toBe(true);

    const payloadJson = Buffer.from(first.payloadBase64, "base64").toString(
      "utf8",
    );
    expect(payloadJson).not.toMatch(/\s/);

    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual([
      "schemaVersion",
      "environment",
      "taxiId",
      "slotCount",
      "entries",
    ]);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.environment).toBe("test");
    expect(payload.taxiId).toBe(TAXI_ID);
    expect(payload.slotCount).toBe(12);

    const entries = payload.entries as Record<string, unknown>[];
    expect(entries).toHaveLength(12);
    expect(Object.keys(entries[0])).toEqual([
      "mediaId",
      "sha256",
      "sizeBytes",
      "durationMs",
      "campaignId",
      "startAt",
      "endAt",
    ]);
    expect(entries[0]).toEqual({
      mediaId: "media-1",
      sha256: sha256HexFor(1),
      sizeBytes: 1_000_001,
      durationMs: SPOT_DURATION_MS,
      campaignId: "campaign-1",
      startAt: VALID_START,
      endAt: VALID_END,
    });
    expect(entries[11]).toEqual({
      mediaId: "media-12",
      sha256: sha256HexFor(12),
      sizeBytes: 1_000_012,
      durationMs: SPOT_DURATION_MS,
      campaignId: "campaign-12",
      startAt: VALID_START,
      endAt: VALID_END,
    });
  });

  it("ändert die Inhaltsversion bei Reihenfolge, Laufzeitfenster und Medienhash", () => {
    const baseline = createEnvelope(buildLoopPlan(makeInput()));

    const reorderedInput = makeInput();
    const firstMedia = reorderedInput.placements[0].media;
    reorderedInput.placements[0].media = reorderedInput.placements[1].media;
    reorderedInput.placements[1].media = firstMedia;
    const reordered = createEnvelope(buildLoopPlan(reorderedInput));

    const runtimeInput = makeInput();
    runtimeInput.campaigns[0].endAt = "2099-03-03T10:00:00.000Z";
    const runtimeChanged = createEnvelope(buildLoopPlan(runtimeInput));

    const mediaInput = makeInput();
    mediaInput.placements[0].media = {
      ...mediaInput.placements[0].media,
      sha256: "f".repeat(64),
    };
    const mediaChanged = createEnvelope(buildLoopPlan(mediaInput));

    expect(reordered.version).not.toBe(baseline.version);
    expect(runtimeChanged.version).not.toBe(baseline.version);
    expect(mediaChanged.version).not.toBe(baseline.version);

    expect(reordered.payloadBase64).not.toBe(baseline.payloadBase64);
    expect(runtimeChanged.payloadBase64).not.toBe(baseline.payloadBase64);
    expect(mediaChanged.payloadBase64).not.toBe(baseline.payloadBase64);

    for (const envelope of [reordered, runtimeChanged, mediaChanged]) {
      expect(envelope.version).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("Signaturprüfung mit synthetischem P-256-Schlüssel", () => {
  it("verifiziert ein signiertes Manifest mit dem zugehörigen öffentlichen Schlüssel", () => {
    const plan = buildLoopPlan(makeInput());
    const envelope = createEnvelope(plan, "dev");
    const verified = verifySignedManifest(
      envelope,
      expectations({ environment: "dev" }),
    );

    expect(verified.plan).toEqual(plan);
    expect(verified.version).toBe(envelope.version);
    expect(verified.keyId).toBe(KEY_ID);
    expect(verified.environment).toBe("dev");

    const message = buildManifestSignatureMessage(
      envelope.keyId,
      envelope.version,
      envelope.payloadBase64,
    );
    expect(
      cryptoVerify(
        "sha256",
        Buffer.from(message, "utf8"),
        { key: keyPair.publicKey, dsaEncoding: "der" },
        Buffer.from(envelope.signatureBase64, "base64"),
      ),
    ).toBe(true);
  });
});

describe("Ablehnung manipulierter oder falsch gebundener Manifeste", () => {
  const plan = buildLoopPlan(makeInput());
  const envelope = createEnvelope(plan);

  it("weist ein manipuliertes Nutzlastbyte mit passender Version über die Signatur ab", () => {
    const originalBytes = Buffer.from(envelope.payloadBase64, "base64");
    const tamperedText = originalBytes
      .toString("utf8")
      .replace('"mediaId":"media-1"', '"mediaId":"media-9"');
    expect(tamperedText).not.toBe(originalBytes.toString("utf8"));

    const tamperedBytes = Buffer.from(tamperedText, "utf8");
    const tamperedEnvelope = {
      ...envelope,
      payloadBase64: tamperedBytes.toString("base64"),
      version: sha256Hex(tamperedBytes),
    };

    expectManifestError(
      () => verifySignedManifest(tamperedEnvelope, expectations()),
      "invalid_signature",
    );
  });

  it("weist ein manipuliertes Nutzlastbyte ohne passende Version ab", () => {
    const originalBytes = Buffer.from(envelope.payloadBase64, "base64");
    const tamperedBytes = Buffer.from(
      originalBytes
        .toString("utf8")
        .replace('"mediaId":"media-1"', '"mediaId":"media-9"'),
      "utf8",
    );

    expectManifestError(
      () =>
        verifySignedManifest(
          { ...envelope, payloadBase64: tamperedBytes.toString("base64") },
          expectations(),
        ),
      "payload_version_mismatch",
    );
  });

  it("weist einen falschen öffentlichen Schlüssel ab", () => {
    expectManifestError(
      () =>
        verifySignedManifest(
          envelope,
          expectations({
            trustedKeys: new Map<string, KeyObject>([
              [KEY_ID, otherKeyPair.publicKey],
            ]),
          }),
        ),
      "invalid_signature",
    );
  });

  it("weist eine unbekannte Schlüsselkennung ab", () => {
    expectManifestError(
      () =>
        verifySignedManifest(
          { ...envelope, keyId: "unknown-key" },
          expectations(),
        ),
      "unknown_key_id",
    );
  });

  it("weist eine falsche Taxi-Bindung ab", () => {
    expectManifestError(
      () =>
        verifySignedManifest(
          envelope,
          expectations({ taxiId: "taxi-999" }),
        ),
      "taxi_mismatch",
    );
  });

  it("weist eine falsche Umgebungsbindung ab", () => {
    expectManifestError(
      () =>
        verifySignedManifest(
          envelope,
          expectations({ environment: "dev" }),
        ),
      "environment_mismatch",
    );
  });
});

describe("Strikte Format- und Größeprüfung", () => {
  const plan = buildLoopPlan(makeInput());
  const envelope = createEnvelope(plan);

  it("weist ungültige Base64-Kodierung der Nutzlast ab", () => {
    expectManifestError(
      () =>
        verifySignedManifest(
          { ...envelope, payloadBase64: "not_base64!" },
          expectations(),
        ),
      "invalid_payload_base64",
    );
  });

  it("weist ungültige Base64-Kodierung der Signatur ab", () => {
    expectManifestError(
      () =>
        verifySignedManifest(
          { ...envelope, signatureBase64: "%%%%" },
          expectations(),
        ),
      "invalid_signature_base64",
    );
  });

  it("weist eine Nutzlast über 64 KiB ab", () => {
    const oversized = Buffer.alloc(
      MANIFEST_MAX_PAYLOAD_BYTES + 1,
      0x41,
    ).toString("base64");

    expectManifestError(
      () =>
        verifySignedManifest(
          { ...envelope, payloadBase64: oversized },
          expectations(),
        ),
      "payload_too_large",
    );
  });

  it("weist eine unbekannte Schemaversion im Envelope ab", () => {
    expectManifestError(
      () =>
        verifySignedManifest(
          { ...envelope, schemaVersion: 2 },
          expectations(),
        ),
      "invalid_schema_version",
    );
  });

  it("weist eine unbekannte Schemaversion in der Nutzlast ab", () => {
    const crafted = signRawPayload(
      '{"schemaVersion":2,"environment":"test","taxiId":"taxi-001","slotCount":12,"entries":[]}',
    );

    expectManifestError(
      () => verifySignedManifest(crafted, expectations()),
      "invalid_schema_version",
    );
  });

  it("weist eine vom Nutzlast-Hash abweichende Version ab", () => {
    expectManifestError(
      () =>
        verifySignedManifest(
          { ...envelope, version: "0".repeat(64) },
          expectations(),
        ),
      "payload_version_mismatch",
    );
  });

  it("weist eine ungültige Schlüsselkennung ab", () => {
    expectManifestError(
      () =>
        verifySignedManifest(
          { ...envelope, keyId: "bad key" },
          expectations(),
        ),
      "invalid_key_id",
    );
  });

  it("weist einen unvollständigen Envelope ab", () => {
    const { version: _version, ...incomplete } = envelope;
    void _version;

    expectManifestError(
      () => verifySignedManifest(incomplete, expectations()),
      "invalid_envelope",
    );
  });

  it("weist nicht parsebare Nutzlast kontrolliert ab", () => {
    const crafted = signRawPayload("kein json");

    expectManifestError(
      () => verifySignedManifest(crafted, expectations()),
      "invalid_payload_json",
    );
  });
});
