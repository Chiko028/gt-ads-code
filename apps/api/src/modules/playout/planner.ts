/**
 * CX-006 / GT-ADS-003 (L-03, F-B04, F-A07): Deterministischer
 * fixed_slot-Schleifenplaner.
 *
 * Der Dienst verarbeitet ausschließlich explizite Eingaben. Er liest keine
 * Systemzeit, filtert nicht nach der aktuellen Uhrzeit und greift nicht auf
 * Datenbank, Netzwerk oder Dateisystem zu. Start- und Endzeitpunkte werden
 * nach der Validierung aus CX-004 unverändert übernommen.
 *
 * Bewusst NICHT enthalten: Standardplatzanzahl, automatische Befüllung,
 * Gewichtung, Rotation, Exklusivität, Wiederholung von Medien ohne eigene
 * Platzbelegung, Upload oder Kampagnenverwaltung.
 */

import { validateCampaignRuntime } from "../campaigns/runtimeWindow.js";
import {
  LoopPlanError,
  type LoopPlan,
  type LoopPlanCampaign,
  type LoopPlanCampaignStatus,
  type LoopPlanErrorCode,
  type LoopPlanErrorDetails,
  type LoopPlanInput,
  type LoopPlanPlacement,
  type LoopPlanSpot,
} from "./types.js";

// Der Planer ist der öffentliche Einstieg des Moduls; Typen und Fehlerklasse
// bleiben für Aufrufer direkt erreichbar.
export * from "./types.js";

/** L-03: Jeder Spot dieser Schleife dauert exakt 15 Sekunden. */
export const SPOT_DURATION_MS = 15_000;

const MIN_SLOT_COUNT = 12;
const MAX_SLOT_COUNT = 16;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const CAMPAIGN_STATUSES: ReadonlySet<LoopPlanCampaignStatus> = new Set([
  "draft",
  "active",
  "paused",
  "finished",
  "archived",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => isNonEmptyText(entry));
}

function fail(
  code: LoopPlanErrorCode,
  message: string,
  details: LoopPlanErrorDetails = {},
): never {
  throw new LoopPlanError(code, message, details);
}

/**
 * Prüft die Struktur einer übergebenen Kampagne. Die Laufzeit wird über die
 * vorhandene CX-004-Validierung geprüft, damit keine zweite Zeitlogik entsteht.
 */
function validateCampaign(value: unknown, index: number): LoopPlanCampaign {
  if (!isRecord(value)) {
    fail(
      "invalid_campaign",
      `Die Kampagne an Index ${index} muss als Objekt vorliegen.`,
      { field: `campaigns[${index}]` },
    );
  }

  if (!isNonEmptyText(value.campaignId)) {
    fail(
      "invalid_campaign",
      `Die Kampagne an Index ${index} benötigt eine nicht leere campaignId.`,
      { field: `campaigns[${index}].campaignId` },
    );
  }

  if (
    typeof value.status !== "string" ||
    !CAMPAIGN_STATUSES.has(value.status as LoopPlanCampaignStatus)
  ) {
    fail(
      "invalid_campaign",
      `Die Kampagne "${value.campaignId}" hat einen unbekannten Zustand.`,
      { field: "status", campaignId: value.campaignId },
    );
  }

  if (!isStringArray(value.targetTaxiIds)) {
    fail(
      "invalid_campaign",
      `Die Kampagne "${value.campaignId}" benötigt targetTaxiIds als Textliste.`,
      { field: "targetTaxiIds", campaignId: value.campaignId },
    );
  }

  if (!isStringArray(value.targetGroupIds)) {
    fail(
      "invalid_campaign",
      `Die Kampagne "${value.campaignId}" benötigt targetGroupIds als Textliste.`,
      { field: "targetGroupIds", campaignId: value.campaignId },
    );
  }

  const runtime = validateCampaignRuntime(value.startAt, value.endAt);
  if (!runtime.ok) {
    fail(
      "invalid_runtime_window",
      `Die Kampagne "${value.campaignId}" hat kein gültiges UTC-Laufzeitfenster.`,
      {
        field: "runtimeWindow",
        campaignId: value.campaignId,
        runtimeErrors: runtime.errors,
      },
    );
  }

  return {
    campaignId: value.campaignId,
    status: value.status as LoopPlanCampaignStatus,
    startAt: runtime.value.startAt,
    endAt: runtime.value.endAt,
    targetTaxiIds: [...value.targetTaxiIds],
    targetGroupIds: [...value.targetGroupIds],
  };
}

/** Prüft eine Medienreferenz; die 15-s-Bedingung folgt separat. */
function validateMedia(value: unknown, position: number): LoopPlanPlacement["media"] {
  if (!isRecord(value)) {
    fail(
      "invalid_media",
      `Die Platzbelegung ${position} benötigt eine Medienreferenz.`,
      { field: "media", position },
    );
  }

  if (!isNonEmptyText(value.mediaId)) {
    fail(
      "invalid_media",
      `Die Medienreferenz an Position ${position} benötigt eine mediaId.`,
      { field: "media.mediaId", position },
    );
  }

  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
    fail(
      "invalid_media",
      `Die Medienreferenz an Position ${position} benötigt einen SHA-256 in Kleinschreibung.`,
      { field: "media.sha256", position },
    );
  }

  if (
    typeof value.sizeBytes !== "number" ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes <= 0
  ) {
    fail(
      "invalid_media",
      `Die Medienreferenz an Position ${position} benötigt eine positive Byteanzahl.`,
      { field: "media.sizeBytes", position },
    );
  }

  return {
    mediaId: value.mediaId,
    sha256: value.sha256,
    sizeBytes: value.sizeBytes,
    durationMs: value.durationMs as number,
  };
}

/** Prüft die lückenlose Positionsmenge 1 bis slotCount. */
function validatePositions(placements: readonly unknown[], slotCount: number): void {
  const seen = new Set<number>();

  for (const candidate of placements) {
    if (!isRecord(candidate)) {
      fail("invalid_position", "Jede Platzbelegung muss als Objekt vorliegen.", {
        field: "placements",
      });
    }

    const position = candidate.position;
    if (
      typeof position !== "number" ||
      !Number.isSafeInteger(position) ||
      position < 1 ||
      position > slotCount
    ) {
      fail(
        "invalid_position",
        `Positionen müssen ganzzahlig zwischen 1 und ${slotCount} liegen.`,
        { field: "position", position: typeof position === "number" ? position : undefined },
      );
    }

    if (seen.has(position)) {
      fail(
        "duplicate_position",
        `Die Position ${position} ist mehrfach belegt.`,
        { field: "position", position },
      );
    }

    seen.add(position);
  }

  const missingPositions: number[] = [];
  for (let position = 1; position <= slotCount; position += 1) {
    if (!seen.has(position)) {
      missingPositions.push(position);
    }
  }

  if (missingPositions.length > 0) {
    fail(
      "missing_position",
      `Die Positionen sind nicht lückenlos; es fehlen: ${missingPositions.join(", ")}.`,
      { field: "position", missingPositions },
    );
  }
}

function campaignIsAssigned(
  campaign: LoopPlanCampaign,
  taxiId: string,
  groupIds: ReadonlySet<string>,
): boolean {
  // Bewusst boolesche Zuordnung: direkte und Gruppenzuordnung derselben
  // Kampagne erzeugen keine zusätzliche Belegung.
  if (campaign.targetTaxiIds.includes(taxiId)) {
    return true;
  }

  return campaign.targetGroupIds.some((groupId) => groupIds.has(groupId));
}

/**
 * Erzeugt aus explizit belegten Plätzen einen deterministischen
 * fixed_slot-Schleifenplan.
 *
 * - slotCount muss ganzzahlig zwischen 12 und 16 liegen.
 * - Positionen müssen lückenlos 1 bis slotCount belegen.
 * - Jeder Spot dauert exakt 15000 ms.
 * - Jede Belegung muss dem Taxi direkt oder über eine übergebene Gruppe
 *   zugeordnet sein.
 * - Nur aktive Kampagnen sind zulässig; fremde Kampagnen werden abgewiesen.
 * - Gültige Start-/Endewerte werden unverändert übernommen.
 *
 * Die Reihenfolge der übergebenen Belegungen beeinflusst das Ergebnis nicht.
 * Fehler werden als typisierte LoopPlanError geworfen.
 */
export function buildLoopPlan(input: LoopPlanInput): LoopPlan {
  if (!isRecord(input)) {
    fail("invalid_taxi_id", "Die Eingabe muss als Objekt vorliegen.", {
      field: "input",
    });
  }

  if (!isNonEmptyText(input.taxiId)) {
    fail("invalid_taxi_id", "Die Taxi-ID muss ein nicht leerer Text sein.", {
      field: "taxiId",
    });
  }

  if (!isStringArray(input.groupIds)) {
    fail("invalid_group_ids", "groupIds muss eine Liste nicht leerer Texte sein.", {
      field: "groupIds",
    });
  }

  if (
    typeof input.slotCount !== "number" ||
    !Number.isSafeInteger(input.slotCount) ||
    input.slotCount < MIN_SLOT_COUNT ||
    input.slotCount > MAX_SLOT_COUNT
  ) {
    fail(
      "invalid_slot_count",
      `slotCount muss eine ganze Zahl zwischen ${MIN_SLOT_COUNT} und ${MAX_SLOT_COUNT} sein.`,
      { field: "slotCount" },
    );
  }

  if (!Array.isArray(input.campaigns)) {
    fail("invalid_campaign", "campaigns muss eine Liste sein.", { field: "campaigns" });
  }

  if (!Array.isArray(input.placements)) {
    fail("invalid_position", "placements muss eine Liste sein.", { field: "placements" });
  }

  const campaigns = new Map<string, LoopPlanCampaign>();
  input.campaigns.forEach((candidate, index) => {
    const campaign = validateCampaign(candidate, index);
    if (campaigns.has(campaign.campaignId)) {
      fail(
        "invalid_campaign",
        `Die Kampagne "${campaign.campaignId}" ist mehrfach definiert.`,
        { field: "campaignId", campaignId: campaign.campaignId },
      );
    }
    campaigns.set(campaign.campaignId, campaign);
  });

  validatePositions(input.placements, input.slotCount);

  const groupIds = new Set(input.groupIds);
  const spots: LoopPlanSpot[] = [];

  // Sortierung nach Position macht das Ergebnis unabhängig von der
  // Eingabereihenfolge.
  const orderedPlacements = [...input.placements].sort(
    (left, right) => left.position - right.position,
  );

  for (const placement of orderedPlacements) {
    const position = placement.position;

    if (!isNonEmptyText(placement.campaignId)) {
      fail(
        "invalid_campaign",
        `Die Platzbelegung ${position} benötigt eine campaignId.`,
        { field: "campaignId", position },
      );
    }

    const campaign = campaigns.get(placement.campaignId);
    if (campaign === undefined) {
      fail(
        "unknown_campaign",
        `Die Kampagne "${placement.campaignId}" wurde nicht explizit übergeben.`,
        { field: "campaignId", position, campaignId: placement.campaignId },
      );
    }

    if (campaign.status !== "active") {
      fail(
        "campaign_not_active",
        `Die Kampagne "${campaign.campaignId}" ist nicht aktiv (Zustand: ${campaign.status}).`,
        { field: "status", position, campaignId: campaign.campaignId },
      );
    }

    if (!campaignIsAssigned(campaign, input.taxiId, groupIds)) {
      fail(
        "not_assigned",
        `Die Kampagne "${campaign.campaignId}" ist dem Taxi weder direkt noch über eine Gruppe zugeordnet.`,
        { field: "targets", position, campaignId: campaign.campaignId },
      );
    }

    const media = validateMedia(placement.media, position);
    if (media.durationMs !== SPOT_DURATION_MS) {
      fail(
        "invalid_spot_duration",
        `Der Spot an Position ${position} muss exakt ${SPOT_DURATION_MS} ms dauern.`,
        { field: "media.durationMs", position },
      );
    }

    spots.push({
      position,
      campaignId: campaign.campaignId,
      mediaId: media.mediaId,
      sha256: media.sha256,
      sizeBytes: media.sizeBytes,
      durationMs: media.durationMs,
      startAt: campaign.startAt,
      endAt: campaign.endAt,
    });
  }

  return {
    taxiId: input.taxiId,
    slotCount: input.slotCount,
    loopDurationMs: input.slotCount * SPOT_DURATION_MS,
    spots,
  };
}
