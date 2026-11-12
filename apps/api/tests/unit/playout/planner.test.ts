import { describe, expect, it } from "vitest";
import {
  buildLoopPlan,
  LoopPlanBuildError,
  SPOT_DURATION_MS,
  validateLoopPlan,
  type LoopPlan,
  type LoopPlanValidationError,
} from "../../../src/modules/playout/planner.js";
import {
  validateBookings,
  type BookingValidationError,
} from "../../../src/modules/playout/validateBookings.js";

const TAXI_ID = "taxi-cx025";
const GROUP_A = "group-cx025-a";
const GROUP_B = "group-cx025-b";
const VALID_START = "2099-03-01T10:00:00.000Z";
const VALID_END = "2099-03-02T10:00:00.000Z";

interface PlanInputCampaign {
  id: string;
  status: string;
  startAt: string;
  endAt: string;
  taxiIds: string[];
  groupIds: string[];
}

interface PlanInputBooking {
  position: number;
  campaign: PlanInputCampaign;
  media: {
    id: string;
    sha256: string;
    sizeBytes: number;
    durationMs: number;
  };
}

interface PlanInput {
  taxiId: string;
  groupIds: string[];
  slotCount: number;
  bookings: PlanInputBooking[];
}

function sha256For(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

function makeBooking(
  seed: number,
  overrides: Partial<PlanInputBooking> = {},
  campaignOverrides: Partial<PlanInputCampaign> = {},
): PlanInputBooking {
  return {
    position: seed,
    campaign: {
      id: `campaign-${seed}`,
      status: "active",
      startAt: VALID_START,
      endAt: VALID_END,
      taxiIds: [TAXI_ID],
      groupIds: [],
      ...campaignOverrides,
    },
    media: {
      id: `media-${seed}`,
      sha256: sha256For(seed),
      sizeBytes: 1_000_000 + seed,
      durationMs: SPOT_DURATION_MS,
    },
    ...overrides,
  };
}

function makeInput(slotCount: number = 12): PlanInput {
  return {
    taxiId: TAXI_ID,
    groupIds: [GROUP_A, GROUP_B],
    slotCount,
    bookings: Array.from({ length: slotCount }, (_, index) =>
      makeBooking(index + 1),
    ),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectValidPlan(value: unknown): LoopPlan {
  const result = validateLoopPlan(value);
  expect(result.valid).toBe(true);
  if (!result.valid) {
    throw new Error("Erwartet wurde ein gültiger Schleifenplan.");
  }
  return result.value;
}

function expectInvalidPlan(value: unknown): LoopPlanValidationError[] {
  const result = validateLoopPlan(value);
  expect(result.valid).toBe(false);
  if (result.valid) {
    throw new Error("Erwartet wurde ein ungültiger Schleifenplan.");
  }
  expect(result.errors.length).toBeGreaterThan(0);
  return result.errors;
}

function expectRejectedByCx024(input: unknown): BookingValidationError[] {
  const cx024 = validateBookings(input);
  expect(cx024.valid).toBe(false);
  if (cx024.valid) {
    throw new Error("Erwartet wurde eine ungültige CX-024-Belegung.");
  }

  let plan: LoopPlan | undefined;
  try {
    plan = buildLoopPlan(input);
  } catch (error) {
    expect(error).toBeInstanceOf(LoopPlanBuildError);
    const typed = error as LoopPlanBuildError;
    expect(typed.code).toBe("invalid_bookings");
    expect(typed.message.length).toBeGreaterThan(10);
    expect(typed.errors).toEqual(cx024.errors);
    expect(plan).toBeUndefined();
    return cx024.errors;
  }

  throw new Error("Erwartet wurde ein LoopPlanBuildError ohne Teilresultat.");
}

describe("CX-025: gültige Schleifenpläne aus geprüften Belegungen", () => {
  it("erzeugt aus 12 Plätzen exakt 180000 ms und vollständige Einträge in Positionsreihenfolge", () => {
    const plan = buildLoopPlan(makeInput(12));

    expect(plan.taxiId).toBe(TAXI_ID);
    expect(plan.slotCount).toBe(12);
    expect(plan.totalDurationMs).toBe(180_000);
    expect(plan.entries).toHaveLength(12);
    expect(plan.entries.map((entry) => entry.position)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(plan.entries.every((entry) => entry.durationMs === 15_000)).toBe(true);
    expect(
      plan.totalDurationMs,
    ).toBe(plan.entries.reduce((sum, entry) => sum + entry.durationMs, 0));
  });

  it("erzeugt aus 16 Plätzen exakt 240000 ms", () => {
    const plan = buildLoopPlan(makeInput(16));

    expect(plan.slotCount).toBe(16);
    expect(plan.totalDurationMs).toBe(240_000);
    expect(plan.entries).toHaveLength(16);
    expect(plan.entries[15].position).toBe(16);
    expect(
      plan.totalDurationMs,
    ).toBe(plan.entries.reduce((sum, entry) => sum + entry.durationMs, 0));
  });

  it("übernimmt Kampagnen-, Medien- und Zeitfensterdaten vollständig", () => {
    const input = makeInput(12);
    const plan = buildLoopPlan(input);

    expect(plan.entries[0]).toEqual({
      position: 1,
      campaignId: "campaign-1",
      mediaId: "media-1",
      sha256: sha256For(1),
      sizeBytes: 1_000_001,
      durationMs: 15_000,
      startAt: VALID_START,
      endAt: VALID_END,
    });
    expect(plan.entries[11]).toEqual({
      position: 12,
      campaignId: "campaign-12",
      mediaId: "media-12",
      sha256: sha256For(12),
      sizeBytes: 1_000_012,
      durationMs: 15_000,
      startAt: VALID_START,
      endAt: VALID_END,
    });

    const grouped = makeBooking(
      13,
      { position: 1 },
      { taxiIds: [], groupIds: [GROUP_B] },
    );
    const groupedInput = makeInput(12);
    groupedInput.bookings[0] = grouped;
    const groupedPlan = buildLoopPlan(groupedInput);
    expect(groupedPlan.entries[0].campaignId).toBe("campaign-13");
    expect(groupedPlan.entries[0].startAt).toBe(VALID_START);
  });
});

describe("CX-025: Determinismus und Unveränderlichkeit", () => {
  it("erzeugt bei verschiedener Eingabereihenfolge identische Pläne", () => {
    const input = makeInput(12);
    const reversed = clone(input);
    reversed.bookings.reverse();
    reversed.groupIds.reverse();

    expect(buildLoopPlan(reversed)).toEqual(buildLoopPlan(input));
  });

  it("verändert bei Änderungen am Rückgabeplan die ursprünglichen Belegungen nicht", () => {
    const input = makeInput(12);
    const snapshot = clone(input);
    const plan = buildLoopPlan(input);

    plan.taxiId = "taxi-manipulated";
    plan.totalDurationMs = 1;
    plan.entries[0].campaignId = "campaign-manipulated";
    plan.entries[0].mediaId = "media-manipulated";
    plan.entries[0].sha256 = "f".repeat(64);
    plan.entries[0].sizeBytes = 42;
    plan.entries[0].durationMs = 1;
    plan.entries[0].startAt = "2000-01-01T00:00:00.000Z";
    plan.entries[0].endAt = "2000-01-02T00:00:00.000Z";
    plan.entries.pop();
    plan.entries.reverse();

    expect(input).toEqual(snapshot);
    expect(input.bookings[0].campaign.id).toBe("campaign-1");
    expect(input.bookings[0].media.id).toBe("media-1");
    expect(input.bookings[0].media.sha256).toBe(sha256For(1));
    expect(input.bookings).toHaveLength(12);
  });
});

describe("CX-025: ungültige Belegungen werden durch CX-024 abgewiesen", () => {
  it("weist fehlende Plätze ab und füllt keine Standardplätze auf", () => {
    const input = makeInput(12);
    input.bookings.pop();

    const errors = expectRejectedByCx024(input);
    expect(errors.some((error) => error.code === "missing_position")).toBe(true);
    expect(errors.every((error) => error.field !== "media")).toBe(true);
  });

  it("weist 12 Belegungen bei slotCount 16 ohne automatische Auffüllung ab", () => {
    const input = makeInput(12);
    input.slotCount = 16;

    const errors = expectRejectedByCx024(input);
    expect(errors.filter((error) => error.code === "missing_position")).toHaveLength(4);
    expect(errors.map((error) => error.message).join(" ")).toMatch(/13|14|15|16/);
  });

  it("weist doppelte Positionen ab", () => {
    const input = makeInput(12);
    input.bookings[1] = { ...input.bookings[1], position: 1 };

    const errors = expectRejectedByCx024(input);
    expect(errors.some((error) => error.code === "duplicate_position")).toBe(true);
  });

  it("weist nicht aktive, fremde und medienseitig ungültige Belegungen ab", () => {
    const paused = makeInput(12);
    paused.bookings[0].campaign.status = "paused";
    expect(
      expectRejectedByCx024(paused).some((error) => error.code === "campaign_not_active"),
    ).toBe(true);

    const foreign = makeInput(12);
    foreign.bookings[0].campaign.taxiIds = ["other-taxi"];
    foreign.bookings[0].campaign.groupIds = ["other-group"];
    expect(
      expectRejectedByCx024(foreign).some((error) => error.code === "not_assigned"),
    ).toBe(true);

    const badMedia = makeInput(12);
    badMedia.bookings[3].media.durationMs = 14_999;
    badMedia.bookings[3].media.sha256 = "not-a-hash";
    const mediaErrors = expectRejectedByCx024(badMedia);
    expect(mediaErrors.some((error) => error.code === "invalid_spot_duration")).toBe(
      true,
    );
    expect(mediaErrors.some((error) => error.code === "invalid_media")).toBe(true);
  });
});

describe("CX-025: Strukturprüfung des serialisierbaren Plans", () => {
  it("akzeptiert einen erzeugten und JSON-rundgereisten Plan ohne Zielzuordnungsdaten", () => {
    const plan = buildLoopPlan(makeInput(12));
    const roundTripped = clone(plan);

    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain("targetTaxiIds");
    expect(serialized).not.toContain("targetGroupIds");
    expect(serialized).not.toContain("groupIds");

    const fromObject = expectValidPlan(plan);
    const fromJson = expectValidPlan(roundTripped);
    expect(fromObject).toEqual(plan);
    expect(fromJson).toEqual(plan);
    expect(fromJson).not.toBe(roundTripped);
  });

  it("weist manipulierte Positionen ab", () => {
    const plan = buildLoopPlan(makeInput(12));
    const swapped = clone(plan);
    swapped.entries[0].position = 2;
    swapped.entries[1].position = 1;

    const errors = expectInvalidPlan(swapped);
    expect(errors.some((error) => error.code === "invalid_position")).toBe(true);

    const duplicate = clone(plan);
    duplicate.entries[1].position = 1;
    duplicate.entries[11].position = 1;
    const duplicateErrors = expectInvalidPlan(duplicate);
    expect(
      duplicateErrors.some(
        (error) => error.code === "duplicate_position" || error.code === "invalid_position",
      ),
    ).toBe(true);
  });

  it("weist manipulierte Summendauer und Eintragsdauer ab", () => {
    const plan = buildLoopPlan(makeInput(12));

    const total = clone(plan);
    total.totalDurationMs = 179_000;
    expect(
      expectInvalidPlan(total).some(
        (error) => error.code === "invalid_total_duration",
      ),
    ).toBe(true);

    const duration = clone(plan);
    duration.entries[5].durationMs = 15_001;
    expect(
      expectInvalidPlan(duration).some(
        (error) => error.code === "invalid_spot_duration",
      ),
    ).toBe(true);
  });

  it("weist manipulierte Medienwerte und Laufzeitfenster ab", () => {
    const plan = buildLoopPlan(makeInput(12));

    const media = clone(plan);
    media.entries[0].sha256 = "F".repeat(64);
    media.entries[0].sizeBytes = 0;
    const mediaErrors = expectInvalidPlan(media);
    expect(mediaErrors.some((error) => error.code === "invalid_media")).toBe(true);

    const runtime = clone(plan);
    runtime.entries[0].endAt = VALID_START;
    expect(
      expectInvalidPlan(runtime).some(
        (error) => error.code === "invalid_runtime_window",
      ),
    ).toBe(true);

    const invalidDate = clone(plan);
    invalidDate.entries[7].startAt = "2099-02-30T10:00:00.000Z";
    expect(
      expectInvalidPlan(invalidDate).some(
        (error) => error.code === "invalid_runtime_window",
      ),
    ).toBe(true);
  });
});
