import { describe, expect, it } from "vitest";
import { buildLoopPlan, SPOT_DURATION_MS } from "../../../src/modules/playout/planner.js";
import {
  LoopPlanError,
  type LoopPlan,
  type LoopPlanCampaign,
  type LoopPlanErrorCode,
  type LoopPlanInput,
  type LoopPlanMedia,
  type LoopPlanPlacement,
} from "../../../src/modules/playout/types.js";

const TAXI_ID = "taxi-001";
const GROUP_A = "group-a";
const GROUP_B = "group-b";
const VALID_START = "2099-03-01T10:00:00.000Z";
const VALID_END = "2099-03-02T10:00:00.000Z";

function sha256For(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

function makeMedia(seed: number, durationMs: number = SPOT_DURATION_MS): LoopPlanMedia {
  return {
    mediaId: `media-${seed}`,
    sha256: sha256For(seed),
    sizeBytes: 1_000_000 + seed,
    durationMs,
  };
}

function makeCampaign(
  seed: number,
  overrides: Partial<LoopPlanCampaign> = {},
): LoopPlanCampaign {
  return {
    campaignId: `campaign-${seed}`,
    status: "active",
    startAt: VALID_START,
    endAt: VALID_END,
    targetTaxiIds: [TAXI_ID],
    targetGroupIds: [],
    ...overrides,
  };
}

type MutableLoopPlanInput = Omit<LoopPlanInput, "campaigns" | "placements"> & {
  campaigns: LoopPlanCampaign[];
  placements: LoopPlanPlacement[];
};

function makeInput(
  slotCount: number = 12,
  overrides: Partial<MutableLoopPlanInput> = {},
): MutableLoopPlanInput {
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
    groupIds: [GROUP_A, GROUP_B],
    slotCount,
    campaigns,
    placements,
    ...overrides,
  };
}

function expectError(
  action: () => unknown,
  code: LoopPlanErrorCode,
): LoopPlanError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(LoopPlanError);
    const typed = error as LoopPlanError;
    expect(typed.code).toBe(code);
    expect(typed.message.length).toBeGreaterThan(10);
    return typed;
  }
  throw new Error(`Erwartet wurde ein LoopPlanError mit Code ${code}.`);
}

function positionsOf(plan: LoopPlan): number[] {
  return plan.spots.map((spot) => spot.position);
}

describe("CX-006 fixed_slot: gültige Schleifenpläne", () => {
  it("erzeugt aus 12 expliziten Plätzen 180 Sekunden in Positionsreihenfolge", () => {
    const plan = buildLoopPlan(makeInput(12));

    expect(plan.taxiId).toBe(TAXI_ID);
    expect(plan.slotCount).toBe(12);
    expect(plan.loopDurationMs).toBe(180_000);
    expect(positionsOf(plan)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(plan.spots).toHaveLength(12);
    expect(plan.spots.every((spot) => spot.durationMs === 15_000)).toBe(true);
  });

  it("erzeugt aus 16 expliziten Plätzen 240 Sekunden in Positionsreihenfolge", () => {
    const plan = buildLoopPlan(makeInput(16));

    expect(plan.slotCount).toBe(16);
    expect(plan.loopDurationMs).toBe(240_000);
    expect(positionsOf(plan)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    expect(plan.spots).toHaveLength(16);
  });

  it("übernimmt Kampagnen-ID, Medien-ID, SHA-256, Byteanzahl und Dauer je Spot", () => {
    const plan = buildLoopPlan(makeInput(12));
    const first = plan.spots[0];

    expect(first).toEqual({
      position: 1,
      campaignId: "campaign-1",
      mediaId: "media-1",
      sha256: sha256For(1),
      sizeBytes: 1_000_001,
      durationMs: 15_000,
      startAt: VALID_START,
      endAt: VALID_END,
    });
  });

  it("liefert bei anderer Eingabereihenfolge dasselbe Ergebnis", () => {
    const input = makeInput(12);
    const shuffled: LoopPlanInput = {
      ...input,
      campaigns: [...input.campaigns].reverse(),
      placements: [...input.placements].reverse(),
    };

    expect(buildLoopPlan(shuffled)).toEqual(buildLoopPlan(input));
  });

  it("erlaubt dieselbe Medienreferenz nur über mehrere ausdrückliche Platzbelegungen", () => {
    const input = makeInput(12);
    input.placements[1] = {
      ...input.placements[1],
      campaignId: input.placements[0].campaignId,
      media: input.placements[0].media,
    };

    const plan = buildLoopPlan(input);
    const reused = plan.spots.filter((spot) => spot.mediaId === "media-1");

    expect(reused).toHaveLength(2);
    expect(reused.map((spot) => spot.position)).toEqual([1, 2]);
  });

  it("übernimmt Start und Ende verlustfrei als UTC-Laufzeitfenster", () => {
    const pastStart = "2020-02-29T23:59:59.999Z";
    const pastEnd = "2020-03-01T00:00:00.001Z";
    const input = makeInput(12);
    input.campaigns = input.campaigns.map((campaign) => ({
      ...campaign,
      startAt: pastStart,
      endAt: pastEnd,
    }));

    const plan = buildLoopPlan(input);

    expect(plan.spots).toHaveLength(12);
    for (const spot of plan.spots) {
      expect(spot.startAt).toBe(pastStart);
      expect(spot.endAt).toBe(pastEnd);
    }
  });
});

describe("CX-006 fixed_slot: Platzanzahl und Positionen", () => {
  it("weist 11 Plätze mit typisiertem Fehler ab", () => {
    expectError(() => buildLoopPlan(makeInput(11)), "invalid_slot_count");
  });

  it("weist 17 Plätze mit typisiertem Fehler ab", () => {
    expectError(() => buildLoopPlan(makeInput(17)), "invalid_slot_count");
  });

  it("weist nicht ganzzahlige Platzanzahl ab", () => {
    expectError(() => buildLoopPlan(makeInput(12.5)), "invalid_slot_count");
  });

  it("weist doppelte Positionen ab", () => {
    const input = makeInput(12);
    input.placements[1] = { ...input.placements[1], position: 1 };

    const error = expectError(() => buildLoopPlan(input), "duplicate_position");
    expect(error.details.position).toBe(1);
  });

  it("weist fehlende Positionen ab", () => {
    const input = makeInput(12);
    input.placements.pop();

    const error = expectError(() => buildLoopPlan(input), "missing_position");
    expect(error.details.missingPositions).toEqual([12]);
  });

  it("weist Positionen außerhalb von 1 bis slotCount ab", () => {
    const input = makeInput(12);
    input.placements[0] = { ...input.placements[0], position: 0 };

    expectError(() => buildLoopPlan(input), "invalid_position");
  });
});

describe("CX-006 fixed_slot: Spotdauer", () => {
  it("weist 14999 ms ab", () => {
    const input = makeInput(12);
    input.placements[3] = {
      ...input.placements[3],
      media: makeMedia(4, 14_999),
    };

    const error = expectError(() => buildLoopPlan(input), "invalid_spot_duration");
    expect(error.details.position).toBe(4);
  });

  it("weist 15001 ms ab", () => {
    const input = makeInput(12);
    input.placements[3] = {
      ...input.placements[3],
      media: makeMedia(4, 15_001),
    };

    expectError(() => buildLoopPlan(input), "invalid_spot_duration");
  });
});

describe("CX-006 fixed_slot: Kampagnen und Zuordnung", () => {
  it("erzeugt bei direkter Taxi- und Gruppenzuordnung derselben Kampagne keine zusätzliche Belegung", () => {
    const both = makeCampaign(99, {
      targetTaxiIds: [TAXI_ID],
      targetGroupIds: [GROUP_A, GROUP_B],
    });
    const input = makeInput(12);
    input.campaigns.push(both);
    input.placements[0] = {
      position: 1,
      campaignId: both.campaignId,
      media: makeMedia(99),
    };

    const plan = buildLoopPlan(input);

    expect(plan.spots).toHaveLength(12);
    expect(plan.spots.filter((spot) => spot.campaignId === both.campaignId)).toHaveLength(1);
  });

  it("akzeptiert eine Kampagne, die nur über eine übergebene Gruppe zugeordnet ist", () => {
    const grouped = makeCampaign(42, {
      targetTaxiIds: [],
      targetGroupIds: [GROUP_B],
    });
    const input = makeInput(12);
    input.campaigns.push(grouped);
    input.placements[0] = {
      position: 1,
      campaignId: grouped.campaignId,
      media: makeMedia(42),
    };

    const plan = buildLoopPlan(input);
    expect(plan.spots[0].campaignId).toBe(grouped.campaignId);
  });

  it("weist fremde Kampagnen ab", () => {
    const input = makeInput(12);
    input.placements[0] = {
      ...input.placements[0],
      campaignId: "foreign-campaign",
    };

    const error = expectError(() => buildLoopPlan(input), "unknown_campaign");
    expect(error.details.campaignId).toBe("foreign-campaign");
  });

  it("weist archivierte Kampagnen ab", () => {
    const input = makeInput(12);
    input.campaigns[0] = makeCampaign(1, { status: "archived" });

    expectError(() => buildLoopPlan(input), "campaign_not_active");
  });

  it("weist pausierte Kampagnen ab", () => {
    const input = makeInput(12);
    input.campaigns[0] = makeCampaign(1, { status: "paused" });

    expectError(() => buildLoopPlan(input), "campaign_not_active");
  });

  it("weist Kampagnen ab, die weder dem Taxi noch einer Gruppe zugeordnet sind", () => {
    const input = makeInput(12);
    input.campaigns[0] = makeCampaign(1, {
      targetTaxiIds: ["other-taxi"],
      targetGroupIds: ["other-group"],
    });

    expectError(() => buildLoopPlan(input), "not_assigned");
  });
});

describe("CX-006 fixed_slot: Laufzeitfenster über CX-004", () => {
  it("weist Ende vor Start über die CX-004-Validierung ab", () => {
    const input = makeInput(12);
    input.campaigns[0] = makeCampaign(1, {
      startAt: "2026-03-02T10:00:00.000Z",
      endAt: "2026-03-01T10:00:00.000Z",
    });

    const error = expectError(() => buildLoopPlan(input), "invalid_runtime_window");
    expect(error.details.runtimeErrors?.[0]?.code).toBe("invalid_interval");
  });

  it("weist ungültige Kalenderzeitpunkte über die CX-004-Validierung ab", () => {
    const input = makeInput(12);
    input.campaigns[0] = makeCampaign(1, {
      startAt: "2026-02-30T10:00:00.000Z",
      endAt: "2026-03-01T10:00:00.000Z",
    });

    const error = expectError(() => buildLoopPlan(input), "invalid_runtime_window");
    expect(error.details.runtimeErrors?.[0]?.code).toBe("invalid_timestamp");
    expect(error.details.runtimeErrors?.[0]?.field).toBe("startAt");
  });
});
