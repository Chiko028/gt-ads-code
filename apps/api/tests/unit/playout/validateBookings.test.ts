import { describe, expect, it } from "vitest";
import {
  MAX_MEDIA_SIZE_BYTES,
  SPOT_DURATION_MS,
  validateBookings,
  type BookingValidationError,
  type BookingValidationErrorCode,
  type BookingValidationField,
  type BookingValidationResult,
  type ValidatedBookings,
} from "../../../src/modules/playout/validateBookings.js";
import { validateCampaignRuntime } from "../../../src/modules/campaigns/runtimeWindow.js";

const TAXI_ID = "taxi-024";
const GROUP_A = "group-a";
const GROUP_B = "group-b";

const PAST_START = "2020-02-29T23:59:59.999Z";
const PAST_END = "2020-03-01T00:00:00.000Z";
const FUTURE_START = "2099-03-01T10:00:00.000Z";
const FUTURE_END = "2099-03-02T10:00:00.000Z";

interface RawCampaign {
  id: string;
  status?: string;
  startAt: string;
  endAt: string;
  taxiIds: string[];
  groupIds: string[];
  [key: string]: unknown;
}

interface RawMedia {
  id: string;
  sha256: string;
  sizeBytes: number;
  durationMs: number;
  [key: string]: unknown;
}

interface RawBooking {
  position: number;
  campaign: RawCampaign;
  media: RawMedia;
  [key: string]: unknown;
}

interface RawInput {
  taxiId: string;
  groupIds: string[];
  slotCount: number;
  bookings: RawBooking[];
  [key: string]: unknown;
}

function sha256For(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

function makeMedia(seed: number, overrides: Partial<RawMedia> = {}): RawMedia {
  return {
    id: `media-${seed}`,
    sha256: sha256For(seed),
    sizeBytes: 1_000_000 + seed,
    durationMs: SPOT_DURATION_MS,
    ...overrides,
  };
}

function makeCampaign(seed: number, overrides: Partial<RawCampaign> = {}): RawCampaign {
  return {
    id: `campaign-${seed}`,
    status: "active",
    startAt: FUTURE_START,
    endAt: FUTURE_END,
    taxiIds: [TAXI_ID],
    groupIds: [],
    ...overrides,
  };
}

function makeBooking(
  position: number,
  seed: number = position,
  overrides: Partial<RawBooking> = {},
): RawBooking {
  return {
    position,
    campaign: makeCampaign(seed),
    media: makeMedia(seed),
    ...overrides,
  };
}

function makeInput(slotCount: number = 12, overrides: Partial<RawInput> = {}): RawInput {
  const bookings = Array.from({ length: slotCount }, (_, index) =>
    makeBooking(index + 1),
  );

  return {
    taxiId: TAXI_ID,
    groupIds: [GROUP_A, GROUP_B],
    slotCount,
    bookings,
    ...overrides,
  };
}

function expectValid(result: BookingValidationResult): ValidatedBookings {
  expect(result.valid).toBe(true);
  if (!result.valid) {
    throw new Error(`Erwartet wurde ein gültiges Ergebnis: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

function expectInvalid(result: BookingValidationResult): BookingValidationError[] {
  expect(result.valid).toBe(false);
  if (result.valid) {
    throw new Error("Erwartet wurde ein ungültiges Ergebnis.");
  }
  return result.errors;
}

function findError(
  errors: readonly BookingValidationError[],
  code: BookingValidationErrorCode,
  field: BookingValidationField,
): BookingValidationError {
  const found = errors.find((error) => error.code === code && error.field === field);
  if (found === undefined) {
    throw new Error(
      `Fehler ${code}/${field} fehlt. Vorhanden: ${errors
        .map((error) => `${error.code}/${error.field}`)
        .join(", ")}`,
    );
  }
  return found;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

describe("CX-024: gültige 12- und 16-Platz-Belegungen", () => {
  it.each([12, 16] as const)(
    "gibt %i Belegungen unabhängig von der Reihenfolge inhaltlich unverändert und aufsteigend nach Position aus",
    (slotCount) => {
      const input = makeInput(slotCount);
      const value = expectValid(validateBookings(input));

      expect(value.taxiId).toBe(TAXI_ID);
      expect(value.groupIds).toEqual([GROUP_A, GROUP_B]);
      expect(value.slotCount).toBe(slotCount);
      expect(value.bookings.map((booking) => booking.position)).toEqual(
        Array.from({ length: slotCount }, (_, index) => index + 1),
      );
      expect(value.bookings).toEqual(
        input.bookings.map((booking) => ({
          position: booking.position,
          campaign: {
            id: booking.campaign.id,
            status: "active",
            startAt: booking.campaign.startAt,
            endAt: booking.campaign.endAt,
            taxiIds: [...booking.campaign.taxiIds],
            groupIds: [...booking.campaign.groupIds],
          },
          media: {
            id: booking.media.id,
            sha256: booking.media.sha256,
            sizeBytes: booking.media.sizeBytes,
            durationMs: booking.media.durationMs,
          },
        })),
      );

      const reversed: RawInput = {
        ...input,
        groupIds: [...input.groupIds],
        bookings: [...input.bookings].reverse(),
      };

      expect(validateBookings(reversed)).toEqual(validateBookings(input));
    },
  );

  it("vervielfacht weder durch direkte noch durch zusätzliche Gruppenzuordnung eine Belegung", () => {
    const input = makeInput(12);
    input.bookings = input.bookings.map((booking) => ({
      ...booking,
      campaign: {
        ...booking.campaign,
        taxiIds: [TAXI_ID],
        groupIds: [GROUP_A, GROUP_B],
      },
    }));

    const value = expectValid(validateBookings(input));

    expect(value.bookings).toHaveLength(12);
    expect(new Set(value.bookings.map((booking) => booking.position)).size).toBe(12);
    expect(value.bookings[0].campaign.groupIds).toEqual([GROUP_A, GROUP_B]);
    expect(value.bookings[0].campaign.taxiIds).toEqual([TAXI_ID]);
  });

  it("akzeptiert eine reine Gruppenzuordnung genau einmal je ausdrücklicher Platzbelegung", () => {
    const input = makeInput(12);
    input.bookings = input.bookings.map((booking) => ({
      ...booking,
      campaign: {
        ...booking.campaign,
        taxiIds: [],
        groupIds: [GROUP_A],
      },
    }));

    const value = expectValid(validateBookings(input));

    expect(value.bookings).toHaveLength(12);
    expect(value.bookings.map((booking) => booking.position)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });
});

interface StructureCase {
  name: string;
  mutate: (input: RawInput) => void;
  code: BookingValidationErrorCode;
  field: BookingValidationField;
}

describe("CX-024: Platzanzahl, Positionen und Spotdauer", () => {
  const cases: StructureCase[] = [
    {
      name: "Platzanzahl 11",
      mutate: (input) => {
        input.slotCount = 11;
      },
      code: "invalid_slot_count",
      field: "slotCount",
    },
    {
      name: "Platzanzahl 17",
      mutate: (input) => {
        input.slotCount = 17;
      },
      code: "invalid_slot_count",
      field: "slotCount",
    },
    {
      name: "Platzanzahl 0",
      mutate: (input) => {
        input.slotCount = 0;
      },
      code: "invalid_slot_count",
      field: "slotCount",
    },
    {
      name: "gebrochene Platzanzahl 12.5",
      mutate: (input) => {
        input.slotCount = 12.5;
      },
      code: "invalid_slot_count",
      field: "slotCount",
    },
    {
      name: "Platzanzahl als Text",
      mutate: (input) => {
        input.slotCount = "12" as unknown as number;
      },
      code: "invalid_slot_count",
      field: "slotCount",
    },
    {
      name: "Lücke bei Position 5",
      mutate: (input) => {
        input.bookings = input.bookings.filter((booking) => booking.position !== 5);
      },
      code: "missing_position",
      field: "position",
    },
    {
      name: "doppelte Position 1",
      mutate: (input) => {
        input.bookings.push(makeBooking(1, 99));
      },
      code: "duplicate_position",
      field: "position",
    },
    {
      name: "Position 0",
      mutate: (input) => {
        input.bookings[0].position = 0;
      },
      code: "invalid_position",
      field: "position",
    },
    {
      name: "negative Position -1",
      mutate: (input) => {
        input.bookings[0].position = -1;
      },
      code: "invalid_position",
      field: "position",
    },
    {
      name: "gebrochene Position 2.5",
      mutate: (input) => {
        input.bookings[0].position = 2.5;
      },
      code: "invalid_position",
      field: "position",
    },
    {
      name: "Position 13 bei slotCount 12",
      mutate: (input) => {
        input.bookings[0].position = 13;
      },
      code: "invalid_position",
      field: "position",
    },
    {
      name: "Position als Text",
      mutate: (input) => {
        input.bookings[0].position = "1" as unknown as number;
      },
      code: "invalid_position",
      field: "position",
    },
    {
      name: "Spotdauer 4999 ms",
      mutate: (input) => {
        input.bookings[0].media.durationMs = 4_999;
      },
      code: "invalid_spot_duration",
      field: "media.durationMs",
    },
    {
      name: "Spotdauer 60001 ms",
      mutate: (input) => {
        input.bookings[0].media.durationMs = 60_001;
      },
      code: "invalid_spot_duration",
      field: "media.durationMs",
    },
    {
      name: "Spotdauer mit Bruchteil",
      mutate: (input) => {
        input.bookings[0].media.durationMs = 15_000.5;
      },
      code: "invalid_spot_duration",
      field: "media.durationMs",
    },
    {
      name: "Spotdauer als Text",
      mutate: (input) => {
        input.bookings[0].media.durationMs = "15000" as unknown as number;
      },
      code: "invalid_spot_duration",
      field: "media.durationMs",
    },
  ];

  it.each(cases)("$name liefert einen stabilen feldbezogenen Fehler", (testCase) => {
    const input = makeInput(12);
    testCase.mutate(input);

    const first = expectInvalid(validateBookings(input));
    const error = findError(first, testCase.code, testCase.field);

    expect(error.message.length).toBeGreaterThan(10);
    expect(error.message).not.toContain("{");

    const second = expectInvalid(validateBookings(input));
    expect(second).toEqual(first);
  });

  it("sortiert mehrere Fehler deterministisch nach Strukturfeld und Position", () => {
    const input = makeInput(12);
    input.bookings[2] = {
      ...input.bookings[2],
      campaign: { ...input.bookings[2].campaign, status: "paused" },
      media: { ...input.bookings[2].media, sha256: "A".repeat(64) },
    };
    input.bookings = input.bookings.filter((booking) => booking.position !== 5);

    const first = expectInvalid(validateBookings(input));
    const reversed = expectInvalid(
      validateBookings({ ...input, bookings: [...input.bookings].reverse() }),
    );

    expect(reversed).toEqual(first);
    expect(first.map((error) => error.field)).toEqual([
      "position",
      "campaign.status",
      "media.sha256",
    ]);
  });
});

interface RejectionCase {
  name: string;
  mutate: (input: RawInput) => void;
  code: BookingValidationErrorCode;
  field: BookingValidationField;
}

describe("CX-024: Zielzuordnung, Kampagnenstatus und Medienreferenzen", () => {
  const cases: RejectionCase[] = [
    {
      name: "fremde direkte Taxi-Zuordnung",
      mutate: (input) => {
        input.bookings[0].campaign.taxiIds = ["taxi-foreign"];
        input.bookings[0].campaign.groupIds = [];
      },
      code: "not_assigned",
      field: "campaign.targets",
    },
    {
      name: "fremde Gruppenzuordnung",
      mutate: (input) => {
        input.bookings[0].campaign.taxiIds = [];
        input.bookings[0].campaign.groupIds = ["group-foreign"];
      },
      code: "not_assigned",
      field: "campaign.targets",
    },
    {
      name: "pausierte Kampagne",
      mutate: (input) => {
        input.bookings[0].campaign.status = "paused";
      },
      code: "campaign_not_active",
      field: "campaign.status",
    },
    {
      name: "fehlender Kampagnenstatus",
      mutate: (input) => {
        delete input.bookings[0].campaign.status;
      },
      code: "campaign_not_active",
      field: "campaign.status",
    },
    {
      name: "Status in Großschreibung",
      mutate: (input) => {
        input.bookings[0].campaign.status = "ACTIVE";
      },
      code: "campaign_not_active",
      field: "campaign.status",
    },
    {
      name: "leere Medien-ID",
      mutate: (input) => {
        input.bookings[0].media.id = "";
      },
      code: "invalid_media",
      field: "media.id",
    },
    {
      name: "Medien-ID aus Leerzeichen",
      mutate: (input) => {
        input.bookings[0].media.id = "   ";
      },
      code: "invalid_media",
      field: "media.id",
    },
    {
      name: "SHA-256 in Großschreibung",
      mutate: (input) => {
        input.bookings[0].media.sha256 = "A".repeat(64);
      },
      code: "invalid_media",
      field: "media.sha256",
    },
    {
      name: "SHA-256 mit 63 Zeichen",
      mutate: (input) => {
        input.bookings[0].media.sha256 = "a".repeat(63);
      },
      code: "invalid_media",
      field: "media.sha256",
    },
    {
      name: "SHA-256 mit 65 Zeichen",
      mutate: (input) => {
        input.bookings[0].media.sha256 = "a".repeat(65);
      },
      code: "invalid_media",
      field: "media.sha256",
    },
    {
      name: "SHA-256 mit Nicht-Hex-Zeichen",
      mutate: (input) => {
        input.bookings[0].media.sha256 = `${"a".repeat(63)}g`;
      },
      code: "invalid_media",
      field: "media.sha256",
    },
    {
      name: "fehlender SHA-256",
      mutate: (input) => {
        delete (input.bookings[0].media as unknown as Record<string, unknown>).sha256;
      },
      code: "invalid_media",
      field: "media.sha256",
    },
    {
      name: "Byteanzahl 0",
      mutate: (input) => {
        input.bookings[0].media.sizeBytes = 0;
      },
      code: "invalid_media",
      field: "media.sizeBytes",
    },
    {
      name: "negative Byteanzahl",
      mutate: (input) => {
        input.bookings[0].media.sizeBytes = -1;
      },
      code: "invalid_media",
      field: "media.sizeBytes",
    },
    {
      name: "gebrochene Byteanzahl",
      mutate: (input) => {
        input.bookings[0].media.sizeBytes = 1.5;
      },
      code: "invalid_media",
      field: "media.sizeBytes",
    },
    {
      name: "Byteanzahl über 1000000000",
      mutate: (input) => {
        input.bookings[0].media.sizeBytes = MAX_MEDIA_SIZE_BYTES + 1;
      },
      code: "invalid_media",
      field: "media.sizeBytes",
    },
    {
      name: "nicht sichere Byteanzahl",
      mutate: (input) => {
        input.bookings[0].media.sizeBytes = Number.MAX_SAFE_INTEGER + 1;
      },
      code: "invalid_media",
      field: "media.sizeBytes",
    },
  ];

  it.each(cases)("$name wird abgewiesen", (testCase) => {
    const input = makeInput(12);
    testCase.mutate(input);

    const errors = expectInvalid(validateBookings(input));
    const error = findError(errors, testCase.code, testCase.field);

    expect(error.message.length).toBeGreaterThan(10);
    expect(error.message).not.toContain("{");
  });

  it("akzeptiert die Obergrenze der Byteanzahl", () => {
    const input = makeInput(12);
    input.bookings[0].media.sizeBytes = MAX_MEDIA_SIZE_BYTES;

    const value = expectValid(validateBookings(input));

    expect(value.bookings[0].media.sizeBytes).toBe(MAX_MEDIA_SIZE_BYTES);
  });
});

describe("CX-024: Laufzeitfenster nach CX-004 und Unveränderlichkeit", () => {
  it("weist ein umgekehrtes Laufzeitfenster mit der CX-004-Meldung ab", () => {
    const input = makeInput(12);
    input.bookings[0].campaign.startAt = FUTURE_END;
    input.bookings[0].campaign.endAt = FUTURE_START;

    const errors = expectInvalid(validateBookings(input));
    const error = findError(errors, "invalid_runtime_window", "campaign.interval");
    const cx004 = validateCampaignRuntime(FUTURE_END, FUTURE_START);

    expect(cx004.ok).toBe(false);
    if (cx004.ok) {
      throw new Error("CX-004 hätte das Fenster ablehnen müssen.");
    }
    expect(error.message).toBe(cx004.errors[0].message);
  });

  it("weist einen ungültigen Kalenderzeitpunkt als Feld campaign.startAt ab", () => {
    const input = makeInput(12);
    input.bookings[0].campaign.startAt = "2026-02-30T10:00:00.000Z";

    const errors = expectInvalid(validateBookings(input));
    const error = findError(errors, "invalid_runtime_window", "campaign.startAt");
    const cx004 = validateCampaignRuntime("2026-02-30T10:00:00.000Z", FUTURE_END);

    expect(cx004.ok).toBe(false);
    if (cx004.ok) {
      throw new Error("CX-004 hätte den Zeitpunkt ablehnen müssen.");
    }
    expect(error.message).toBe(cx004.errors[0].message);
  });

  it.each([
    { name: "vergangenes", startAt: PAST_START, endAt: PAST_END },
    { name: "zukünftiges", startAt: FUTURE_START, endAt: FUTURE_END },
  ])("übernimmt ein gültiges $name Fenster unverändert", ({ startAt, endAt }) => {
    const input = makeInput(12);
    input.bookings = input.bookings.map((booking) => ({
      ...booking,
      campaign: { ...booking.campaign, startAt, endAt },
    }));

    const value = expectValid(validateBookings(input));

    for (const booking of value.bookings) {
      expect(booking.campaign.startAt).toBe(startAt);
      expect(booking.campaign.endAt).toBe(endAt);
    }
  });

  it("mutiert die Eingabe nicht und baut neue Referenzen auf", () => {
    const input = makeInput(12);
    const snapshot = structuredClone(input);
    deepFreeze(input);

    const value = expectValid(validateBookings(input));

    expect(input).toEqual(snapshot);
    expect(value.groupIds).not.toBe(input.groupIds);
    expect(value.bookings).not.toBe(input.bookings);
    expect(value.bookings[0]).not.toBe(input.bookings[0]);
    expect(value.bookings[0].campaign).not.toBe(input.bookings[0].campaign);
    expect(value.bookings[0].campaign.taxiIds).not.toBe(
      input.bookings[0].campaign.taxiIds,
    );
    expect(value.bookings[0].media).not.toBe(input.bookings[0].media);
  });

  it("reicht zusätzliche Felder nicht weiter", () => {
    const input = makeInput(12);
    input.extra = "wird nicht übernommen";
    input.bookings[0].extra = "wird nicht übernommen";
    input.bookings[0].campaign.extra = "wird nicht übernommen";
    input.bookings[0].media.extra = "wird nicht übernommen";

    const value = expectValid(validateBookings(input));

    expect(Object.keys(value).sort()).toEqual([
      "bookings",
      "groupIds",
      "slotCount",
      "taxiId",
    ]);
    expect(Object.keys(value.bookings[0]).sort()).toEqual([
      "campaign",
      "media",
      "position",
    ]);
    expect(Object.keys(value.bookings[0].campaign).sort()).toEqual([
      "endAt",
      "groupIds",
      "id",
      "startAt",
      "status",
      "taxiIds",
    ]);
    expect(Object.keys(value.bookings[0].media).sort()).toEqual([
      "durationMs",
      "id",
      "sha256",
      "sizeBytes",
    ]);
  });

  it.each([null, [], "ungültig", 42])(
    "weist eine nicht objektförmige Eingabe %j ab",
    (candidate) => {
      const errors = expectInvalid(validateBookings(candidate));
      findError(errors, "invalid_input", "input");
    },
  );
});
