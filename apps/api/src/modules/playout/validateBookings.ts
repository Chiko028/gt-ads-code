/**
 * CX-024 / CX-006-Ersatz A: Belegungsprüfung für den fixed_slot-Planer.
 *
 * Der Baustein ist reine TypeScript-Anwendungslogik ohne Seiteneffekte: keine
 * Systemzeit, keine I/O, keine Datenbank und keine Mutation der Eingabe. Er
 * prüft ausschließlich bereits explizit übergebene Daten.
 *
 * Bewusst NICHT enthalten: Hashberechnung, Binärprüfung von Medien, Upload,
 * Kampagnenverwaltung, automatische Platzfüllung oder Zielauflösung über eine
 * Datenbank. Die Ziel-ID-Listen sind explizite Eingabedaten.
 */

import { validateCampaignRuntime } from "../campaigns/runtimeWindow.js";

/** L-03: Jeder Spot dieser Schleife dauert exakt 15 Sekunden. */
export const SPOT_DURATION_MS = 15_000;

/** Kleinste zulässige Platzanzahl. */
export const MIN_SLOT_COUNT = 12;

/** Größte zulässige Platzanzahl. */
export const MAX_SLOT_COUNT = 16;

/** Obergrenze für eine geprüfte Medien-Byteanzahl (CX-005). */
export const MAX_MEDIA_SIZE_BYTES = 20_000_000;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Zustand einer für die Belegung zugelassenen Kampagne. */
export type BookingCampaignStatus = "active";

/** Neu aufgebaute, geprüfte Kampagnenreferenz einer Belegung. */
export interface ValidatedBookingCampaign {
  id: string;
  status: BookingCampaignStatus;
  /** Unverändert übernommener UTC-Start aus CX-004. */
  startAt: string;
  /** Unverändert übernommenes UTC-Ende aus CX-004. */
  endAt: string;
  taxiIds: string[];
  groupIds: string[];
}

/** Neu aufgebaute, geprüfte Medienreferenz einer Belegung. */
export interface ValidatedBookingMedia {
  id: string;
  /** 64 kleingeschriebene Hexzeichen. */
  sha256: string;
  sizeBytes: number;
  durationMs: number;
}

/** Eine geprüfte, explizite Platzbelegung. */
export interface ValidatedBooking {
  position: number;
  campaign: ValidatedBookingCampaign;
  media: ValidatedBookingMedia;
}

/** Normalisierter Eingabestand für den Planer, aufsteigend nach Position. */
export interface ValidatedBookings {
  taxiId: string;
  groupIds: string[];
  slotCount: number;
  bookings: ValidatedBooking[];
}

/** Stabile Fehlercodes der Belegungsprüfung. */
export type BookingValidationErrorCode =
  | "invalid_input"
  | "invalid_taxi_id"
  | "invalid_group_ids"
  | "invalid_slot_count"
  | "invalid_bookings"
  | "invalid_booking"
  | "invalid_position"
  | "duplicate_position"
  | "missing_position"
  | "invalid_campaign"
  | "campaign_not_active"
  | "not_assigned"
  | "invalid_media"
  | "invalid_spot_duration"
  | "invalid_runtime_window";

/**
 * Strukturfeld eines Fehlers. Die Reihenfolge dieser Union entspricht der
 * deterministischen Sortierreihenfolge der Fehlerliste.
 */
export type BookingValidationField =
  | "input"
  | "taxiId"
  | "groupIds"
  | "slotCount"
  | "bookings"
  | "position"
  | "campaign"
  | "campaign.id"
  | "campaign.status"
  | "campaign.startAt"
  | "campaign.endAt"
  | "campaign.interval"
  | "campaign.taxiIds"
  | "campaign.groupIds"
  | "campaign.targets"
  | "media"
  | "media.id"
  | "media.sha256"
  | "media.sizeBytes"
  | "media.durationMs";

const FIELD_ORDER: readonly BookingValidationField[] = [
  "input",
  "taxiId",
  "groupIds",
  "slotCount",
  "bookings",
  "position",
  "campaign",
  "campaign.id",
  "campaign.status",
  "campaign.startAt",
  "campaign.endAt",
  "campaign.interval",
  "campaign.taxiIds",
  "campaign.groupIds",
  "campaign.targets",
  "media",
  "media.id",
  "media.sha256",
  "media.sizeBytes",
  "media.durationMs",
];

const FIELD_RANK = new Map<BookingValidationField, number>(
  FIELD_ORDER.map((field, index) => [field, index]),
);

/** Ein feldbezogener Fehler, wie ihn Aufrufer erhalten. */
export interface BookingValidationError {
  code: BookingValidationErrorCode;
  field: BookingValidationField;
  /** Deutsche, menschenlesbare Meldung ohne vollständige Eingabedaten. */
  message: string;
}

/** Diskriminiertes Ergebnis der Belegungsprüfung. */
export type BookingValidationResult =
  | { valid: true; value: ValidatedBookings }
  | { valid: false; errors: BookingValidationError[] };

/** Interner Fehler mit Sortierposition; wird nie nach außen gegeben. */
interface InternalError {
  code: BookingValidationErrorCode;
  field: BookingValidationField;
  message: string;
  /** Position der betroffenen Belegung, sofern bekannt. */
  position?: number;
  /** Stabile Einfügereihenfolge als letzter Tiebreaker. */
  sequence: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyTextArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => isNonEmptyText(entry));
}

function compareErrors(left: InternalError, right: InternalError): number {
  const leftRank = FIELD_RANK.get(left.field) ?? FIELD_ORDER.length;
  const rightRank = FIELD_RANK.get(right.field) ?? FIELD_ORDER.length;

  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  const leftPosition = left.position ?? Number.NEGATIVE_INFINITY;
  const rightPosition = right.position ?? Number.NEGATIVE_INFINITY;

  if (leftPosition !== rightPosition) {
    return leftPosition < rightPosition ? -1 : 1;
  }

  if (left.code !== right.code) {
    return left.code < right.code ? -1 : 1;
  }

  return left.sequence - right.sequence;
}

function toPublicErrors(errors: readonly InternalError[]): BookingValidationError[] {
  return [...errors]
    .sort(compareErrors)
    .map(({ code, field, message }) => ({ code, field, message }));
}

function invalid(errors: readonly InternalError[]): BookingValidationResult {
  return { valid: false, errors: toPublicErrors(errors) };
}

interface FieldErrorOptions {
  position?: number;
  sequence: number;
}

function pushError(
  errors: InternalError[],
  code: BookingValidationErrorCode,
  field: BookingValidationField,
  message: string,
  options: FieldErrorOptions,
): void {
  errors.push({ code, field, message, position: options.position, sequence: options.sequence });
}

/**
 * Prüft eine eingebettete Kampagne und liefert bei Erfolg die neu aufgebaute
 * Referenz. Ziel-IDs werden ausschließlich gegen die explizit übergebenen
 * Werte geprüft; es gibt keine Datenbankauflösung.
 */
function checkCampaign(
  value: unknown,
  position: number | undefined,
  taxiId: string,
  groupIds: ReadonlySet<string>,
  label: string,
  errors: InternalError[],
  sequenceBase: number,
): ValidatedBookingCampaign | null {
  if (!isRecord(value)) {
    pushError(
      errors,
      "invalid_campaign",
      "campaign",
      `Die Kampagne an Position ${label} muss als Objekt vorliegen.`,
      { position, sequence: sequenceBase },
    );
    return null;
  }

  let valid = true;

  if (!isNonEmptyText(value.id)) {
    pushError(
      errors,
      "invalid_campaign",
      "campaign.id",
      `Die Kampagne an Position ${label} benötigt eine nicht leere ID.`,
      { position, sequence: sequenceBase + 1 },
    );
    valid = false;
  }

  if (value.status !== "active") {
    pushError(
      errors,
      "campaign_not_active",
      "campaign.status",
      `Die Kampagne an Position ${label} muss den Status "active" haben.`,
      { position, sequence: sequenceBase + 2 },
    );
    valid = false;
  }

  const runtime = validateCampaignRuntime(value.startAt, value.endAt);
  if (!runtime.ok) {
    runtime.errors.forEach((runtimeError, index) => {
      const field: BookingValidationField =
        runtimeError.field === "startAt"
          ? "campaign.startAt"
          : runtimeError.field === "endAt"
            ? "campaign.endAt"
            : "campaign.interval";
      pushError(
        errors,
        "invalid_runtime_window",
        field,
        runtimeError.message,
        { position, sequence: sequenceBase + 3 + index },
      );
    });
    valid = false;
  }

  const rawTaxiIds = value.taxiIds;
  const hasTaxiIds = isNonEmptyTextArray(rawTaxiIds);
  if (!hasTaxiIds) {
    pushError(
      errors,
      "invalid_campaign",
      "campaign.taxiIds",
      `Die Kampagne an Position ${label} benötigt taxiIds als Liste nicht leerer Texte.`,
      { position, sequence: sequenceBase + 10 },
    );
    valid = false;
  }

  const rawGroupIds = value.groupIds;
  const hasGroupIds = isNonEmptyTextArray(rawGroupIds);
  if (!hasGroupIds) {
    pushError(
      errors,
      "invalid_campaign",
      "campaign.groupIds",
      `Die Kampagne an Position ${label} benötigt groupIds als Liste nicht leerer Texte.`,
      { position, sequence: sequenceBase + 11 },
    );
    valid = false;
  }

  if (hasTaxiIds && hasGroupIds) {
    // Bewusst boolesche Zuordnung: direkte und Gruppenzuordnung derselben
    // Kampagne erzeugen keine zusätzliche Belegung.
    const directlyAssigned = rawTaxiIds.includes(taxiId);
    const groupAssigned = rawGroupIds.some((groupId) => groupIds.has(groupId));

    if (!directlyAssigned && !groupAssigned) {
      pushError(
        errors,
        "not_assigned",
        "campaign.targets",
        `Die Kampagne an Position ${label} ist dem Taxi weder direkt noch über eine übergebene Gruppe zugeordnet.`,
        { position, sequence: sequenceBase + 12 },
      );
      valid = false;
    }
  }

  if (!valid || !runtime.ok) {
    return null;
  }

  return {
    id: value.id as string,
    status: "active",
    startAt: runtime.value.startAt,
    endAt: runtime.value.endAt,
    taxiIds: [...(value.taxiIds as string[])],
    groupIds: [...(value.groupIds as string[])],
  };
}

/** Prüft eine Medienreferenz strukturell; es wird kein Hash berechnet. */
function checkMedia(
  value: unknown,
  position: number | undefined,
  label: string,
  errors: InternalError[],
  sequenceBase: number,
): ValidatedBookingMedia | null {
  if (!isRecord(value)) {
    pushError(
      errors,
      "invalid_media",
      "media",
      `Die Platzbelegung an Position ${label} benötigt eine Medienreferenz.`,
      { position, sequence: sequenceBase },
    );
    return null;
  }

  let valid = true;

  if (!isNonEmptyText(value.id)) {
    pushError(
      errors,
      "invalid_media",
      "media.id",
      `Die Medienreferenz an Position ${label} benötigt eine nicht leere ID.`,
      { position, sequence: sequenceBase + 1 },
    );
    valid = false;
  }

  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
    pushError(
      errors,
      "invalid_media",
      "media.sha256",
      `Die Medienreferenz an Position ${label} benötigt einen SHA-256 aus genau 64 kleingeschriebenen Hexzeichen.`,
      { position, sequence: sequenceBase + 2 },
    );
    valid = false;
  }

  if (
    typeof value.sizeBytes !== "number" ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes <= 0 ||
    value.sizeBytes > MAX_MEDIA_SIZE_BYTES
  ) {
    pushError(
      errors,
      "invalid_media",
      "media.sizeBytes",
      `Die Medienreferenz an Position ${label} benötigt eine positive ganzzahlige Byteanzahl bis ${MAX_MEDIA_SIZE_BYTES}.`,
      { position, sequence: sequenceBase + 3 },
    );
    valid = false;
  }

  if (value.durationMs !== SPOT_DURATION_MS) {
    pushError(
      errors,
      "invalid_spot_duration",
      "media.durationMs",
      `Der Spot an Position ${label} muss exakt ${SPOT_DURATION_MS} ms dauern.`,
      { position, sequence: sequenceBase + 4 },
    );
    valid = false;
  }

  if (!valid) {
    return null;
  }

  return {
    id: value.id as string,
    sha256: value.sha256 as string,
    sizeBytes: value.sizeBytes as number,
    durationMs: value.durationMs as number,
  };
}

/**
 * Validiert explizite Taxi-Platzbelegungen und liefert einen neu aufgebauten,
 * deterministisch nach Position sortierten Eingabestand für den Planer.
 *
 * Die Eingabe wird weder verändert noch weitergereicht. Zusätzliche Felder
 * werden bewusst nicht übernommen. Fehler werden nach Strukturfeld und
 * Position sortiert und enthalten keine vollständigen Eingaben.
 */
export function validateBookings(input: unknown): BookingValidationResult {
  const errors: InternalError[] = [];

  if (!isRecord(input)) {
    return invalid([
      {
        code: "invalid_input",
        field: "input",
        message: "Die Eingabe muss als Objekt vorliegen.",
        sequence: 0,
      },
    ]);
  }

  if (!isNonEmptyText(input.taxiId)) {
    pushError(
      errors,
      "invalid_taxi_id",
      "taxiId",
      "Die Taxi-ID muss ein nicht leerer Text sein.",
      { sequence: 1 },
    );
  }

  if (!isNonEmptyTextArray(input.groupIds)) {
    pushError(
      errors,
      "invalid_group_ids",
      "groupIds",
      "groupIds muss eine Liste nicht leerer Texte sein.",
      { sequence: 2 },
    );
  }

  const slotCountValid =
    typeof input.slotCount === "number" &&
    Number.isSafeInteger(input.slotCount) &&
    input.slotCount >= MIN_SLOT_COUNT &&
    input.slotCount <= MAX_SLOT_COUNT;

  if (!slotCountValid) {
    pushError(
      errors,
      "invalid_slot_count",
      "slotCount",
      `slotCount muss eine ganze Zahl zwischen ${MIN_SLOT_COUNT} und ${MAX_SLOT_COUNT} sein.`,
      { sequence: 3 },
    );
  }

  if (!Array.isArray(input.bookings)) {
    pushError(
      errors,
      "invalid_bookings",
      "bookings",
      "bookings muss eine Liste sein.",
      { sequence: 4 },
    );
  }

  // Ohne gültige Struktur am Rand sind Positions- und Belegungsprüfungen nicht
  // sinnvoll; die Fehler bleiben dennoch feldbezogen und deterministisch.
  if (errors.length > 0) {
    return invalid(errors);
  }

  const taxiId = input.taxiId as string;
  const groupIds = input.groupIds as string[];
  const slotCount = input.slotCount as number;
  const bookings = input.bookings as unknown[];
  const groupIdSet = new Set(groupIds);
  const bookedPositions = new Set<number>();
  const candidates: ValidatedBooking[] = [];

  bookings.forEach((candidate, index) => {
    const sequenceBase = 100 + index * 100;

    if (!isRecord(candidate)) {
      pushError(
        errors,
        "invalid_booking",
        "bookings",
        `Die Belegung an Index ${index} muss als Objekt vorliegen.`,
        { sequence: sequenceBase },
      );
      return;
    }

    const rawPosition = candidate.position;
    const positionValid =
      typeof rawPosition === "number" &&
      Number.isSafeInteger(rawPosition) &&
      rawPosition >= 1 &&
      rawPosition <= slotCount;

    const position = typeof rawPosition === "number" ? rawPosition : undefined;
    const label = positionValid ? String(rawPosition) : `Index ${index}`;

    if (!positionValid) {
      pushError(
        errors,
        "invalid_position",
        "position",
        `Die Position muss eine ganze Zahl zwischen 1 und ${slotCount} sein.`,
        { position, sequence: sequenceBase + 1 },
      );
    } else {
      if (bookedPositions.has(rawPosition)) {
        pushError(
          errors,
          "duplicate_position",
          "position",
          `Die Position ${rawPosition} ist mehrfach belegt.`,
          { position, sequence: sequenceBase + 2 },
        );
      } else {
        bookedPositions.add(rawPosition);
      }
    }

    const campaign = checkCampaign(
      candidate.campaign,
      position,
      taxiId,
      groupIdSet,
      label,
      errors,
      sequenceBase + 10,
    );

    const media = checkMedia(
      candidate.media,
      position,
      label,
      errors,
      sequenceBase + 40,
    );

    if (positionValid && campaign !== null && media !== null) {
      candidates.push({ position: rawPosition, campaign, media });
    }
  });

  // Lücken werden nach dem Sammeln aller Belegungen als eigene, feldbezogene
  // Fehler je fehlender Position ausgegeben.
  for (let position = 1; position <= slotCount; position += 1) {
    if (!bookedPositions.has(position)) {
      pushError(
        errors,
        "missing_position",
        "position",
        `Die Position ${position} ist nicht belegt.`,
        { position, sequence: 10_000 + position },
      );
    }
  }

  if (errors.length > 0) {
    return invalid(errors);
  }

  // Neu aufgebaut und ausdrücklich nach Position sortiert; die Eingabe bleibt
  // unberührt und zusätzliche Felder werden nicht übernommen.
  const normalized = [...candidates]
    .sort((left, right) => left.position - right.position)
    .map((booking) => ({
      position: booking.position,
      campaign: {
        id: booking.campaign.id,
        status: "active" as const,
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
    }));

  return {
    valid: true,
    value: {
      taxiId,
      groupIds: [...groupIds],
      slotCount,
      bookings: normalized,
    },
  };
}
