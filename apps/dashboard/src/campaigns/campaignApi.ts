/**
 * CX-040 / R-207: Lesen und Schreiben der vorhandenen Kampagnenrouten
 * (CX-038 / R-205).
 *
 * Der Client nutzt ausschliesslich die vorhandene Cookie-Sitzung und die
 * JSON-Konventionen aus CX-026/CX-033. Er verwaltet keinen zweiten
 * Anmeldezustand, wiederholt schreibende Anfragen nie automatisch und
 * erfindet keine Felder: Angelegt wird genau mit customer_id, media_id,
 * start_at, end_at, taxi_ids und group_ids (fixed_slot).
 */
import type { FetchLike } from "../admin/adminApi";
import { AdminApiError } from "../admin/adminApi";

export type CampaignStatus = "draft" | "active" | "paused" | "finished";

export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = [
  "draft",
  "active",
  "paused",
  "finished",
];

export interface Campaign {
  readonly id: string;
  readonly customerId: string;
  readonly mediaId: string;
  readonly status: CampaignStatus;
  readonly archived: boolean;
  readonly startAt: string;
  readonly endAt: string;
  readonly taxiIds: readonly string[];
  readonly groupIds: readonly string[];
  readonly revision: number;
}

export interface CustomerOption {
  readonly id: string;
  readonly name: string;
}

export interface MediaOption {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly status: string | null;
}

export interface CampaignWriteInput {
  readonly customerId: string;
  readonly mediaId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly taxiIds: readonly string[];
  readonly groupIds: readonly string[];
}

export interface CampaignPatch {
  readonly status?: CampaignStatus;
  readonly archived?: boolean;
  readonly mediaId?: string;
  readonly startAt?: string;
  readonly endAt?: string;
  readonly taxiIds?: readonly string[];
  readonly groupIds?: readonly string[];
  readonly revision: number;
}

export interface CampaignClientOptions {
  readonly fetchImpl?: FetchLike;
  readonly baseUrl?: string;
  /** Wird ausschliesslich bei 401 geschuetzter Operationen aufgerufen. */
  readonly onUnauthorized?: () => void;
}

export interface CampaignClient {
  listCampaigns(): Promise<Campaign[]>;
  getCampaign(id: string): Promise<Campaign>;
  listCustomers(): Promise<CustomerOption[]>;
  listMedia(): Promise<MediaOption[]>;
  createCampaign(input: CampaignWriteInput): Promise<Campaign>;
  updateCampaign(id: string, patch: CampaignPatch): Promise<Campaign>;
}

const NETWORK_MESSAGE =
  "Der Server ist nicht erreichbar. Bitte die Verbindung prüfen.";
const INVALID_RESPONSE_MESSAGE = "Die Antwort des Servers war ungültig.";
const UNAUTHORIZED_MESSAGE =
  "Die Sitzung ist abgelaufen. Bitte erneut anmelden.";
const FORBIDDEN_MESSAGE = "Die Aktion ist nicht erlaubt.";
const NOT_FOUND_MESSAGE = "Der Eintrag wurde nicht gefunden.";
const INVALID_REQUEST_MESSAGE = "Die Anfrage wurde vom Server abgelehnt.";
const CONFLICT_MESSAGE =
  "Der Eintrag wurde inzwischen geändert. Bitte neu laden und erneut bearbeiten.";
const SERVER_MESSAGE =
  "Der Server hat einen Fehler gemeldet. Bitte später erneut versuchen.";

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return base + path;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function requiredString(
  source: Record<string, unknown>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
}

function optionalString(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return null;
}

function optionalNumber(
  source: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function stringArray(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
    }
    result.push(entry);
  }
  return result;
}

function isCampaignStatus(value: unknown): value is CampaignStatus {
  return (
    typeof value === "string" &&
    (CAMPAIGN_STATUSES as readonly string[]).includes(value)
  );
}

export function parseCampaign(value: unknown): Campaign {
  const item = recordOf(value);
  if (item === null) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  const status = item.status;
  if (!isCampaignStatus(status)) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  if (typeof item.revision !== "number" || !Number.isInteger(item.revision)) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  if (typeof item.archived !== "boolean") {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return {
    id: requiredString(item, ["id"]),
    customerId: requiredString(item, ["customer_id", "customerId"]),
    mediaId: requiredString(item, ["media_id", "mediaId"]),
    status,
    archived: item.archived,
    startAt: requiredString(item, ["start_at", "startAt"]),
    endAt: requiredString(item, ["end_at", "endAt"]),
    taxiIds: stringArray(item.taxi_ids ?? item.taxiIds),
    groupIds: stringArray(item.group_ids ?? item.groupIds),
    revision: item.revision,
  };
}

function parseCampaignList(value: unknown): Campaign[] {
  const body = recordOf(value);
  if (body === null || !Array.isArray(body.items)) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return body.items.map(parseCampaign);
}

function parseCustomer(value: unknown): CustomerOption {
  const item = recordOf(value);
  if (item === null) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return {
    id: requiredString(item, ["id"]),
    name: requiredString(item, ["display_name", "displayName", "name"]),
  };
}

function parseCustomerList(value: unknown): CustomerOption[] {
  const body = recordOf(value);
  if (body === null || !Array.isArray(body.items)) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return body.items.map(parseCustomer);
}

export function parseMediaOption(value: unknown): MediaOption {
  const item = recordOf(value);
  if (item === null) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return {
    id: requiredString(item, ["id", "media_id", "mediaId"]),
    name:
      optionalString(item, [
        "name",
        "display_name",
        "displayName",
        "filename",
        "file_name",
      ]) ?? "Unbekannt",
    sizeBytes: optionalNumber(item, ["size_bytes", "sizeBytes", "size"]),
    sha256: optionalString(item, ["sha256", "sha_256", "content_sha256"]),
    status: optionalString(item, ["status", "check_status", "review_status"]),
  };
}

function parseMediaList(value: unknown): MediaOption[] {
  const body = recordOf(value);
  if (body === null || !Array.isArray(body.items)) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return body.items.map(parseMediaOption);
}

function statusError(status: number): AdminApiError {
  if (status === 401) {
    return new AdminApiError("unauthorized", UNAUTHORIZED_MESSAGE, { status });
  }
  if (status === 403) {
    return new AdminApiError("forbidden", FORBIDDEN_MESSAGE, { status });
  }
  if (status === 404) {
    return new AdminApiError("not_found", NOT_FOUND_MESSAGE, { status });
  }
  if (status === 409) {
    return new AdminApiError("invalid_request", CONFLICT_MESSAGE, { status });
  }
  if (status === 429) {
    return new AdminApiError(
      "rate_limited",
      "Zu viele Anfragen. Bitte später erneut versuchen.",
      { status },
    );
  }
  if (status === 400) {
    return new AdminApiError("invalid_request", INVALID_REQUEST_MESSAGE, {
      status,
    });
  }
  return new AdminApiError("server", SERVER_MESSAGE, { status });
}

async function readJson(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new AdminApiError("network", NETWORK_MESSAGE);
  }
  if (text.trim() === "") {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE, {
      status: response.status,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE, {
      status: response.status,
    });
  }
}

/** Kanonisches JSON des fixed_slot-Vertrags; keine zusaetzlichen Felder. */
export function campaignCreateBody(input: CampaignWriteInput): unknown {
  return {
    customer_id: input.customerId,
    media_id: input.mediaId,
    start_at: input.startAt,
    end_at: input.endAt,
    taxi_ids: [...input.taxiIds],
    group_ids: [...input.groupIds],
  };
}

export function campaignPatchBody(patch: CampaignPatch): unknown {
  const body: Record<string, unknown> = { revision: patch.revision };
  if (patch.status !== undefined) {
    body.status = patch.status;
  }
  if (patch.archived !== undefined) {
    body.archived = patch.archived;
  }
  if (patch.mediaId !== undefined) {
    body.media_id = patch.mediaId;
  }
  if (patch.startAt !== undefined) {
    body.start_at = patch.startAt;
  }
  if (patch.endAt !== undefined) {
    body.end_at = patch.endAt;
  }
  if (patch.taxiIds !== undefined) {
    body.taxi_ids = [...patch.taxiIds];
  }
  if (patch.groupIds !== undefined) {
    body.group_ids = [...patch.groupIds];
  }
  return body;
}

export function createCampaignClient(
  options: CampaignClientOptions = {},
): CampaignClient {
  const fetchImpl: FetchLike =
    options.fetchImpl ??
    ((input, init) => {
      return globalThis.fetch(input, init);
    });
  const baseUrl = options.baseUrl ?? "/v1";
  const onUnauthorized = options.onUnauthorized;

  async function request(
    path: string,
    method: "GET" | "POST" | "PATCH",
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const init: RequestInit = {
      method,
      credentials: "same-origin",
      headers,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetchImpl(joinUrl(baseUrl, path), init);
    } catch {
      throw new AdminApiError("network", NETWORK_MESSAGE);
    }

    if (!response.ok) {
      if (response.status === 401) {
        onUnauthorized?.();
      }
      throw statusError(response.status);
    }
    return response;
  }

  return {
    async listCampaigns(): Promise<Campaign[]> {
      const response = await request("/admin/campaigns", "GET");
      return parseCampaignList(await readJson(response));
    },

    async getCampaign(id: string): Promise<Campaign> {
      const response = await request(
        "/admin/campaigns/" + encodeURIComponent(id),
        "GET",
      );
      return parseCampaign(await readJson(response));
    },

    async listCustomers(): Promise<CustomerOption[]> {
      const response = await request("/admin/customers", "GET");
      return parseCustomerList(await readJson(response));
    },

    async listMedia(): Promise<MediaOption[]> {
      const response = await request("/admin/media", "GET");
      return parseMediaList(await readJson(response));
    },

    async createCampaign(input: CampaignWriteInput): Promise<Campaign> {
      const response = await request(
        "/admin/campaigns",
        "POST",
        campaignCreateBody(input),
      );
      return parseCampaign(await readJson(response));
    },

    async updateCampaign(
      id: string,
      patch: CampaignPatch,
    ): Promise<Campaign> {
      const response = await request(
        "/admin/campaigns/" + encodeURIComponent(id),
        "PATCH",
        campaignPatchBody(patch),
      );
      return parseCampaign(await readJson(response));
    },
  };
}

