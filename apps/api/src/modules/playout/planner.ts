/**
 * CX-025 / CX-006-Ersatz B: Deterministischer Schleifenplan.
 *
 * Der Planer baut ausschließlich aus bereits geprüften Belegungen (CX-024)
 * einen unveränderlich kopierten Taxi-Schleifenplan. Es gibt keine Systemzeit,
 * keine I/O, keine automatische Platzbelegung, keine Gewichtung, Rotation,
 * Zufallsreihenfolge, Uhrzeitfilterung oder zusätzliche Standardplätze.
 *
 * Die Strukturprüfung (`validateLoopPlan`) arbeitet ausschließlich auf der
 * serialisierbaren Planstruktur. Sie prüft bewusst KEINE ursprünglichen Taxi-
 * oder Gruppenzuweisungen, weil diese absichtlich nicht Teil des Plans sind.
 * Sie ist außerdem keine Autorisierungs- oder Signaturprüfung.
 */

import { validateCampaignRuntime } from "../campaigns/runtimeWindow.js";
import {
  MAX_MEDIA_SIZE_BYTES,
  MAX_SPOT_DURATION_MS,
  MIN_SPOT_DURATION_MS,
  isAllowedSpotDurationMs,
  SPOT_DURATION_MS,
  validateBookings,
  type BookingValidationError,
  type BookingValidationErrorCode,
} from "./validateBookings.js";
import {
  LoopPlanError,
  type LoopPlan as LegacyLoopPlan,
  type LoopPlanCampaign,
  type LoopPlanErrorCode,
  type LoopPlanErrorDetails,
  type LoopPlanInput,
  type LoopPlanSpot,
} from "./types.js";

/** Bisherige Typen bleiben für bestehende Aufrufer erreichbar. */
export {
  LoopPlanError,
  type LoopPlanCampaign,
  type LoopPlanCampaignStatus,
  type LoopPlanErrorCode,
  type LoopPlanErrorDetails,
  type LoopPlanInput,
  type LoopPlanMedia,
  type LoopPlanPlacement,
  type LoopPlanSpot,
} from "./types.js";

/** L-03: Standarddauer eines Spots. */
export { SPOT_DURATION_MS };

const MIN_SLOT_COUNT = 12;
const MAX_SLOT_COUNT = 16;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Ein geordneter, vollständig kopierter Eintrag des Schleifenplans. */
export interface LoopPlanEntry {
  /** Lückenlose Position 1 bis slotCount, in aufsteigender Reihenfolge. */
  position: number;
  campaignId: string;
  mediaId: string;
  /** 64 kleingeschriebene Hexzeichen. */
  sha256: string;
  sizeBytes: number;
  durationMs: number;
  /** Unverändert aus CX-024/CX-004 übernommener UTC-Start. */
  startAt: string;
  /** Unverändert aus CX-024/CX-004 übernommenes UTC-Ende. */
  endAt: string;
}

/** Deterministischer, serialisierbarer Taxi-Schleifenplan. */
export interface LoopPlan {
  taxiId: string;
  slotCount: number;
  totalDurationMs: number;
  entries: LoopPlanEntry[];
}

/** Stabile Fehlercodes der Plan-Strukturprüfung. */
export type LoopPlanValidationCode =
  | "invalid_plan"
  | "invalid_taxi_id"
  | "invalid_slot_count"
  | "invalid_entries"
  | "invalid_position"
  | "duplicate_position"
  | "missing_position"
  | "invalid_campaign_id"
  | "invalid_media_id"
  | "invalid_media"
  | "invalid_spot_duration"
  | "invalid_total_duration"
  | "invalid_runtime_window";

/** Ein feldbezogener Befund der Plan-Strukturprüfung. */
export interface LoopPlanValidationError {
  code: LoopPlanValidationCode;
  field: string;
  position?: number;
  message: string;
}

/** Diskriminiertes Ergebnis der Plan-Strukturprüfung. */
export type LoopPlanValidationResult =
  | { valid: true; value: LoopPlan }
  | { valid: false; errors: LoopPlanValidationError[] };

/**
 * Strukturierter Fehler des Planbaus. Die Belegungsfehler stammen unverändert
 * aus CX-024; es wird niemals ein Teilplan zurückgegeben.
 */
export class LoopPlanBuildError extends Error {
  readonly code = "invalid_bookings" as const;
  readonly errors: readonly BookingValidationError[];

  constructor(errors: readonly BookingValidationError[]) {
    super(
      "Die übergebenen Platzbelegungen sind ungültig; es wurde kein Schleifenplan erzeugt.",
    );
    this.name = "LoopPlanBuildError";
    this.errors = errors.map((error) => ({ ...error }));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Baut Plan-Einträge ausschließlich neu auf; keine Eingabereferenzen. */
function toEntry(
  position: number,
  campaignId: string,
  mediaId: string,
  sha256: string,
  sizeBytes: number,
  durationMs: number,
  startAt: string,
  endAt: string,
): LoopPlanEntry {
  return {
    position,
    campaignId,
    mediaId,
    sha256,
    sizeBytes,
    durationMs,
    startAt,
    endAt,
  };
}

function totalDurationOf(entries: readonly LoopPlanEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.durationMs, 0);
}

/**
 * Erzeugt aus geprüften CX-024-Belegungen einen deterministischen Schleifen-
 * plan. Ungültige Belegungen werden als LoopPlanBuildError mit den
 * strukturierten CX-024-Fehlern abgewiesen; es entsteht kein Teilresultat.
 */
function buildFromBookings(input: unknown): LoopPlan {
  const result = validateBookings(input);

  if (!result.valid) {
    throw new LoopPlanBuildError(result.errors);
  }

  const entries: LoopPlanEntry[] = result.value.bookings.map((booking) =>
    toEntry(
      booking.position,
      booking.campaign.id,
      booking.media.id,
      booking.media.sha256,
      booking.media.sizeBytes,
      booking.media.durationMs,
      booking.campaign.startAt,
      booking.campaign.endAt,
    ),
  );

  return {
    taxiId: result.value.taxiId,
    slotCount: result.value.slotCount,
    totalDurationMs: totalDurationOf(entries),
    entries,
  };
}

const BOOKING_ERROR_TO_LOOP_ERROR: Readonly<
  Record<BookingValidationErrorCode, LoopPlanErrorCode>
> = {
  invalid_input: "invalid_taxi_id",
  invalid_taxi_id: "invalid_taxi_id",
  invalid_group_ids: "invalid_group_ids",
  invalid_slot_count: "invalid_slot_count",
  invalid_bookings: "invalid_position",
  invalid_booking: "invalid_position",
  invalid_position: "invalid_position",
  duplicate_position: "duplicate_position",
  missing_position: "missing_position",
  invalid_campaign: "invalid_campaign",
  campaign_not_active: "campaign_not_active",
  not_assigned: "not_assigned",
  invalid_media: "invalid_media",
  invalid_spot_duration: "invalid_spot_duration",
  invalid_runtime_window: "invalid_runtime_window",
};

/**
 * Übersetzt den ersten CX-024-Fehler in den bestehenden LoopPlanError, damit
 * CX-007 unverändert auf strukturierte Fehler prüfen kann.
 */
function toLegacyError(errors: readonly BookingValidationError[]): LoopPlanError {
  const first = errors[0];
  if (first === undefined) {
    return new LoopPlanError(
      "invalid_campaign",
      "Die Platzbelegungen konnten nicht geprüft werden.",
    );
  }

  return new LoopPlanError(BOOKING_ERROR_TO_LOOP_ERROR[first.code], first.message, {
    field: first.field,
  });
}

/**
 * Übersetzt die frühere, explizite Eingabeform (campaigns/placements) in
 * CX-024-Belegungen. Dadurch existiert nur eine Kampagnen- und Medienprüfung
 * im Modul; die eigentliche Validierung bleibt ausschließlich in CX-024.
 */
function buildLegacyPlan(input: unknown): LegacyLoopPlan {
  if (!isRecord(input)) {
    throw new LoopPlanError(
      "invalid_taxi_id",
      "Die Eingabe muss als Objekt vorliegen.",
      { field: "input" },
    );
  }

  if (!Array.isArray(input.campaigns)) {
    throw new LoopPlanError("invalid_campaign", "campaigns muss eine Liste sein.", {
      field: "campaigns",
    });
  }

  if (!Array.isArray(input.placements)) {
    throw new LoopPlanError(
      "invalid_position",
      "placements muss eine Liste sein.",
      { field: "placements" },
    );
  }

  const campaigns = new Map<string, LoopPlanCampaign>();
  for (const candidate of input.campaigns) {
    if (!isRecord(candidate) || !isNonEmptyText(candidate.campaignId)) {
      throw new LoopPlanError(
        "invalid_campaign",
        "Jede Kampagne benötigt eine nicht leere campaignId.",
        { field: "campaignId" },
      );
    }

    if (campaigns.has(candidate.campaignId)) {
      throw new LoopPlanError(
        "invalid_campaign",
        `Die Kampagne "${candidate.campaignId}" ist mehrfach definiert.`,
        { field: "campaignId", campaignId: candidate.campaignId },
      );
    }

    campaigns.set(candidate.campaignId, candidate as unknown as LoopPlanCampaign);
  }

  const bookings = input.placements.map((candidate) => {
    if (!isRecord(candidate)) {
      return { position: candidate, campaign: null, media: null };
    }

    const campaignId = candidate.campaignId;
    if (!isNonEmptyText(campaignId)) {
      return {
        position: candidate.position,
        campaign: null,
        media: candidate.media,
      };
    }

    const campaign = campaigns.get(campaignId);
    if (campaign === undefined) {
      throw new LoopPlanError(
        "unknown_campaign",
        `Die Kampagne "${campaignId}" wurde nicht explizit übergeben.`,
        {
          field: "campaignId",
          position:
            typeof candidate.position === "number" ? candidate.position : undefined,
          campaignId,
        },
      );
    }

    const media = candidate.media;
    return {
      position: candidate.position,
      campaign: {
        id: campaign.campaignId,
        status: campaign.status,
        startAt: campaign.startAt,
        endAt: campaign.endAt,
        taxiIds: campaign.targetTaxiIds,
        groupIds: campaign.targetGroupIds,
      },
      media: isRecord(media)
        ? {
            id: media.mediaId,
            sha256: media.sha256,
            sizeBytes: media.sizeBytes,
            durationMs: media.durationMs,
          }
        : media,
    };
  });

  const result = validateBookings({
    taxiId: input.taxiId,
    groupIds: input.groupIds,
    slotCount: input.slotCount,
    bookings,
  });

  if (!result.valid) {
    throw toLegacyError(result.errors);
  }

  const spots: LoopPlanSpot[] = result.value.bookings.map((booking) => ({
    position: booking.position,
    campaignId: booking.campaign.id,
    mediaId: booking.media.id,
    sha256: booking.media.sha256,
    sizeBytes: booking.media.sizeBytes,
    durationMs: booking.media.durationMs,
    startAt: booking.campaign.startAt,
    endAt: booking.campaign.endAt,
  }));

  return {
    taxiId: result.value.taxiId,
    slotCount: result.value.slotCount,
    loopDurationMs: spots.reduce((sum, spot) => sum + spot.durationMs, 0),
    spots,
  };
}

function usesLegacyShape(input: unknown): boolean {
  return (
    isRecord(input) &&
    !Array.isArray(input.bookings) &&
    (Array.isArray(input.campaigns) || Array.isArray(input.placements))
  );
}

/**
 * Erzeugt aus geprüften Belegungen einen unveränderlich kopierten Taxi-
 * Schleifenplan in Positionsreihenfolge.
 *
 * Die frühere explizite Eingabeform bleibt für bestehende Aufrufer (CX-007)
 * verfügbar und wird ebenfalls über CX-024 geprüft. Neue Aufrufer übergeben
 * die CX-024-Eingabe mit `bookings`.
 */
export function buildLoopPlan(input: LoopPlanInput): LegacyLoopPlan;
export function buildLoopPlan(input: unknown): LoopPlan;
export function buildLoopPlan(input: unknown): LoopPlan | LegacyLoopPlan {
  if (usesLegacyShape(input)) {
    return buildLegacyPlan(input);
  }

  return buildFromBookings(input);
}

interface ValidationCollector {
  errors: LoopPlanValidationError[];
  add(
    code: LoopPlanValidationCode,
    field: string,
    message: string,
    position?: number,
  ): void;
}

function createCollector(): ValidationCollector {
  const errors: LoopPlanValidationError[] = [];
  return {
    errors,
    add(code, field, message, position) {
      errors.push({
        code,
        field,
        ...(position === undefined ? {} : { position }),
        message,
      });
    },
  };
}

/**
 * Prüft ausschließlich die serialisierbare Planstruktur: 12–16 Plätze,
 * lückenlose eindeutige Positionen, 5000–60000 ms je Spot, korrekte Gesamtdauer,
 * nichtleere IDs, gültige SHA-256-/Bytewerte und gültige Laufzeitfenster über
 * CX-004. Taxi-/Gruppenzuweisungen sind absichtlich nicht Teil des Plans.
 */
export function validateLoopPlan(input: unknown): LoopPlanValidationResult {
  const collector = createCollector();

  if (!isRecord(input)) {
    collector.add("invalid_plan", "plan", "Der Plan muss als Objekt vorliegen.");
    return { valid: false, errors: collector.errors };
  }

  if (!isNonEmptyText(input.taxiId)) {
    collector.add(
      "invalid_taxi_id",
      "taxiId",
      "Der Plan benötigt eine nicht leere Taxi-ID.",
    );
  }

  const slotCount = input.slotCount;
  const slotCountValid =
    typeof slotCount === "number" &&
    Number.isSafeInteger(slotCount) &&
    slotCount >= MIN_SLOT_COUNT &&
    slotCount <= MAX_SLOT_COUNT;

  if (!slotCountValid) {
    collector.add(
      "invalid_slot_count",
      "slotCount",
      `slotCount muss eine ganze Zahl zwischen ${MIN_SLOT_COUNT} und ${MAX_SLOT_COUNT} sein.`,
    );
  }

  const rawEntries = input.entries;
  if (!Array.isArray(rawEntries)) {
    collector.add(
      "invalid_entries",
      "entries",
      "Der Plan benötigt eine Eintragsliste.",
    );
    return { valid: false, errors: collector.errors };
  }

  if (slotCountValid && rawEntries.length !== slotCount) {
    collector.add(
      "invalid_entries",
      "entries",
      `Der Plan muss genau ${slotCount} Einträge enthalten.`,
    );
  }

  const seenPositions = new Set<number>();
  const entries: LoopPlanEntry[] = [];
  let durationSum = 0;
  let durationSumValid = true;

  rawEntries.forEach((candidate, index) => {
    const expectedPosition = index + 1;

    if (!isRecord(candidate)) {
      collector.add(
        "invalid_entries",
        `entries[${index}]`,
        `Der Eintrag an Index ${index} muss als Objekt vorliegen.`,
      );
      durationSumValid = false;
      return;
    }

    const position = candidate.position;
    const maxPosition = slotCountValid ? slotCount : MAX_SLOT_COUNT;
    const positionValid =
      typeof position === "number" &&
      Number.isSafeInteger(position) &&
      position >= 1 &&
      position <= maxPosition;

    if (!positionValid) {
      collector.add(
        "invalid_position",
        `entries[${index}].position`,
        `Die Position muss eine ganze Zahl zwischen 1 und ${maxPosition} sein.`,
        typeof position === "number" ? position : undefined,
      );
    } else {
      if (seenPositions.has(position)) {
        collector.add(
          "duplicate_position",
          `entries[${index}].position`,
          `Die Position ${position} ist mehrfach belegt.`,
          position,
        );
      } else {
        seenPositions.add(position);
      }

      if (position !== expectedPosition) {
        collector.add(
          "invalid_position",
          `entries[${index}].position`,
          `Der Eintrag an Index ${index} muss Position ${expectedPosition} tragen.`,
          position,
        );
      }
    }

    if (!isNonEmptyText(candidate.campaignId)) {
      collector.add(
        "invalid_campaign_id",
        `entries[${index}].campaignId`,
        `Der Eintrag an Position ${expectedPosition} benötigt eine nicht leere campaignId.`,
        expectedPosition,
      );
    }

    if (!isNonEmptyText(candidate.mediaId)) {
      collector.add(
        "invalid_media_id",
        `entries[${index}].mediaId`,
        `Der Eintrag an Position ${expectedPosition} benötigt eine nicht leere mediaId.`,
        expectedPosition,
      );
    }

    if (
      typeof candidate.sha256 !== "string" ||
      !SHA256_PATTERN.test(candidate.sha256)
    ) {
      collector.add(
        "invalid_media",
        `entries[${index}].sha256`,
        `Der Eintrag an Position ${expectedPosition} benötigt einen SHA-256 aus genau 64 kleingeschriebenen Hexzeichen.`,
        expectedPosition,
      );
    }

    if (
      typeof candidate.sizeBytes !== "number" ||
      !Number.isSafeInteger(candidate.sizeBytes) ||
      candidate.sizeBytes <= 0 ||
      candidate.sizeBytes > MAX_MEDIA_SIZE_BYTES
    ) {
      collector.add(
        "invalid_media",
        `entries[${index}].sizeBytes`,
        `Der Eintrag an Position ${expectedPosition} benötigt eine positive ganzzahlige Byteanzahl bis ${MAX_MEDIA_SIZE_BYTES}.`,
        expectedPosition,
      );
    }

    const durationMs = candidate.durationMs;
    if (!isAllowedSpotDurationMs(durationMs)) {
      collector.add(
        "invalid_spot_duration",
        `entries[${index}].durationMs`,
        `Der Spot an Position ${expectedPosition} muss zwischen ${MIN_SPOT_DURATION_MS} und ${MAX_SPOT_DURATION_MS} ms dauern.`,
        expectedPosition,
      );
      durationSumValid = false;
    } else {
      durationSum += durationMs;
    }

    const runtime = validateCampaignRuntime(candidate.startAt, candidate.endAt);
    if (!runtime.ok) {
      for (const runtimeError of runtime.errors) {
        collector.add(
          "invalid_runtime_window",
          `entries[${index}].${runtimeError.field}`,
          runtimeError.message,
          expectedPosition,
        );
      }
      return;
    }

    entries.push(
      toEntry(
        expectedPosition,
        candidate.campaignId as string,
        candidate.mediaId as string,
        candidate.sha256 as string,
        candidate.sizeBytes as number,
        candidate.durationMs as number,
        runtime.value.startAt,
        runtime.value.endAt,
      ),
    );
  });

  if (slotCountValid) {
    for (let position = 1; position <= slotCount; position += 1) {
      if (!seenPositions.has(position)) {
        collector.add(
          "missing_position",
          `entries[${position - 1}].position`,
          `Die Position ${position} ist nicht belegt.`,
          position,
        );
      }
    }
  }

  if (
    typeof input.totalDurationMs !== "number" ||
    !isNonNegativeSafeInteger(input.totalDurationMs)
  ) {
    collector.add(
      "invalid_total_duration",
      "totalDurationMs",
      "totalDurationMs muss eine nicht negative ganze Zahl sein.",
    );
  } else if (durationSumValid && input.totalDurationMs !== durationSum) {
    collector.add(
      "invalid_total_duration",
      "totalDurationMs",
      `totalDurationMs muss der Summe der Eintragsdauern (${durationSum} ms) entsprechen.`,
    );
  }

  if (collector.errors.length > 0 || !slotCountValid) {
    return { valid: false, errors: collector.errors };
  }

  const plan: LoopPlan = {
    taxiId: input.taxiId as string,
    slotCount: slotCount as number,
    totalDurationMs: input.totalDurationMs as number,
    entries: entries.map((entry) => ({ ...entry })),
  };

  return { valid: true, value: plan };
}
