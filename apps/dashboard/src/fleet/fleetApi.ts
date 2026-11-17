/**
 * CX-037 / R-104, R-106: typisierter Dashboard-Adapter fuer die in CX-035
 * festgelegte Verwaltungs-API.
 *
 * Der Adapter nutzt ausschliesslich die vorhandene Cookie-Sitzung. Er
 * verwaltet weder Token noch Cookies, wiederholt schreibende Anfragen nie
 * automatisch und sendet Revisionen nur dort mit, wo eine Aenderung erwartet
 * wird. Die Routen sind hier zentral gebuendelt, damit die Seite keine
 * Adressen streut.
 *
 * Transport: CX-026 exportiert seinen internen Request-Helfer nicht. Darum
 * nimmt dieser Adapter einen kleinen gleichfoermigen Transport entgegen. Der
 * Standardtransport verwendet denselben same-origin-fetch wie die uebrigen
 * Dashboard-Clients; die 401-Behandlung bleibt zentral ueber onUnauthorized.
 */
import type { FetchLike } from "../admin/adminApi";
import { AdminApiError, isAdminApiError } from "../admin/adminApi";

export const FLEET_PATHS = {
  taxis: "/admin/taxis",
  taxi: (id: string) => "/admin/taxis/" + encodeURIComponent(id),
  taxiTablets: (id: string) =>
    "/admin/taxis/" + encodeURIComponent(id) + "/tablets",
  taxiActivation: (id: string) =>
    "/admin/taxis/" + encodeURIComponent(id) + "/activation",
  /** CX-119: vollstaendige Gruppenzuordnung genau eines Taxis. */
  taxiGroups: (id: string) =>
    "/admin/taxis/" + encodeURIComponent(id) + "/groups",
  playoutPreview: (id: string) =>
    "/admin/taxis/" +
    encodeURIComponent(id) +
    "/playout-preview",
  groups: "/admin/taxi-groups",
  group: (id: string) => "/admin/taxi-groups/" + encodeURIComponent(id),
  tablets: "/admin/tablets",
  tabletActivation: (id: string) =>
    "/admin/tablets/" + encodeURIComponent(id) + "/activation",
  inventory: "/admin/inventory",
  inventoryItem: (deviceId: string) =>
    "/admin/inventory/" + encodeURIComponent(deviceId),
} as const;

export interface FleetTransportRequest {
  readonly path: string;
  readonly method: "GET" | "POST" | "PATCH" | "PUT";
  readonly body?: unknown;
}

/** Injizierbarer Transport; liefert die rohe Fetch-Response. */
export type FleetTransport = (
  request: FleetTransportRequest,
) => Promise<Response>;

export interface FleetTablet {
  readonly id: string;
  readonly label: string | null;
  readonly available: boolean;
  readonly active: boolean;
  readonly revision: number;
}

export interface FleetTaxi {
  readonly id: string;
  readonly displayName: string;
  readonly active: boolean;
  readonly revision: number;
  /** Genau zwei Plaetze; null bedeutet "nicht belegt". */
  readonly tabletIds: readonly [string | null, string | null];
  readonly groupIds: readonly string[];
}

export interface FleetGroup {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
}

export interface FleetInventoryItem {
  readonly deviceId: string;
  readonly serialNumber: string | null;
  readonly deviceType: string | null;
  readonly replacementNote: string | null;
  readonly adminActive: boolean;
  readonly revision: number;
}

/** CX-044: ein geordneter Eintrag des veroeffentlichten Sollplans. */
export interface PlayoutPreviewEntry {
  readonly mediaId: string;
  readonly durationMs: number;
  readonly startAt: string;
  readonly endAt: string;
}

/** CX-044: lesende Vorschau; niemals eine bestaetigte Tablet-Wiedergabe. */
export interface PlayoutPreview {
  readonly taxiId: string;
  readonly manifestVersion: string | null;
  readonly entries: readonly PlayoutPreviewEntry[];
}

export interface TaxiWriteInput {
  readonly id: string;
  readonly displayName: string;
  readonly groupIds: readonly string[];
}

export interface TaxiPatch {
  readonly displayName: string;
  readonly groupIds: readonly string[];
  readonly revision: number;
}

/**
 * CX-139: Die bestehende Aktivierungsroute bestaetigt ausschliesslich den
 * Zustand und die neue Revision. Weitere Taxifelder bleiben unveraendert und
 * werden aus dem bereits bestaetigten Datensatz uebernommen.
 */
export interface TaxiActivationResult {
  readonly active: boolean;
  readonly revision: number;
}

/**
 * CX-140: Die bestehende Tablet-Aktivierungsroute bestaetigt ausschliesslich
 * den Zustand und die neue Revision. Das optionale Taxi der Antwort bleibt
 * fuer diese Ansicht ohne Bedeutung.
 */
export interface TabletActivationResult {
  readonly active: boolean;
  readonly revision: number;
}

/** CX-119: serverbestaetigte Gruppenmenge und Revision eines Taxis. */
export interface TaxiGroupMembership {
  readonly taxiId: string;
  readonly groupIds: readonly string[];
  readonly revision: number;
}

export interface InventoryPatch {
  readonly serialNumber: string | null;
  readonly deviceType: string | null;
  readonly replacementNote: string | null;
  readonly adminActive?: boolean;
  readonly revision: number;
}

export interface FleetClientOptions {
  readonly transport?: FleetTransport;
  readonly fetchImpl?: FetchLike;
  readonly baseUrl?: string;
  /** Wird ausschliesslich bei einer 401 geschuetzter Operation aufgerufen. */
  readonly onUnauthorized?: () => void;
  /** Erfasst die Sitzungsgeneration beim Requeststart. */
  readonly getSessionGeneration?: () => number;
}

export interface FleetClient {
  listTaxis(): Promise<FleetTaxi[]>;
  createTaxi(input: TaxiWriteInput): Promise<FleetTaxi>;
  updateTaxi(id: string, patch: TaxiPatch): Promise<FleetTaxi>;
  assignTablets(
    id: string,
    tabletIds: readonly [string, string],
    revision: number,
  ): Promise<FleetTaxi>;
  setTaxiActive(
    id: string,
    active: boolean,
    revision: number,
  ): Promise<TaxiActivationResult>;
  setTabletActive(
    id: string,
    active: boolean,
    expectedRevision: number,
  ): Promise<TabletActivationResult>;
  listGroups(): Promise<FleetGroup[]>;
  createGroup(name: string): Promise<FleetGroup>;
  /**
   * CX-119: ersetzt die vollstaendige Gruppenmenge eines Taxis in genau
   * einem atomaren Schreibvorgang. Es gibt keine Hinzufuegen-/Entfernen-
   * Aufrufe und keine automatische Wiederholung.
   */
  replaceTaxiGroupMemberships(
    id: string,
    groupIds: readonly string[],
    revision: number,
  ): Promise<TaxiGroupMembership>;
  renameGroup(id: string, name: string, revision: number): Promise<FleetGroup>;
  listTablets(): Promise<FleetTablet[]>;
  listInventory(): Promise<FleetInventoryItem[]>;
  getPlayoutPreview(taxiId: string): Promise<PlayoutPreview>;
  updateInventoryItem(
    deviceId: string,
    patch: InventoryPatch,
  ): Promise<FleetInventoryItem>;
}

const NETWORK_MESSAGE =
  "Der Server ist nicht erreichbar. Bitte die Verbindung prüfen.";
const INVALID_RESPONSE_MESSAGE = "Die Antwort des Servers war ungültig.";
const UNAUTHORIZED_MESSAGE =
  "Die Sitzung ist abgelaufen. Bitte erneut anmelden.";
const FORBIDDEN_MESSAGE = "Die Aktion ist nicht erlaubt.";
const NOT_FOUND_MESSAGE = "Der Eintrag wurde nicht gefunden.";
const INVALID_REQUEST_MESSAGE = "Die Anfrage wurde vom Server abgelehnt.";
export const CONFLICT_MESSAGE =
  "Der Eintrag wurde inzwischen geändert. Bitte die aktuellen Daten prüfen und die Eingabe bewusst wiederholen.";
const RATE_LIMITED_MESSAGE =
  "Zu viele Anfragen. Bitte später erneut versuchen.";
const SERVER_MESSAGE =
  "Der Server hat einen Fehler gemeldet. Bitte später erneut versuchen.";

/** 409 bedeutet Revisionskonflikt, nie einen automatischen Neuversuch. */
export function isFleetConflict(error: unknown): boolean {
  return isAdminApiError(error) && error.status === 409;
}

/** Unklarer Schreibausgang: Netz, 5xx oder unlesbare Antwort. */
export function isUnclearWriteOutcome(error: unknown): boolean {
  return (
    isAdminApiError(error) &&
    (error.kind === "network" ||
      error.kind === "server" ||
      error.kind === "invalid_response")
  );
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return base + path;
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
    return new AdminApiError("rate_limited", RATE_LIMITED_MESSAGE, { status });
  }
  if (status === 400 || status === 422) {
    return new AdminApiError("invalid_request", INVALID_REQUEST_MESSAGE, {
      status,
    });
  }
  return new AdminApiError("server", SERVER_MESSAGE, { status });
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

function revisionOf(source: Record<string, unknown>): number {
  const revision = source.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision)) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return revision;
}

function tabletIdsOf(source: Record<string, unknown>): [string | null, string | null] {
  const raw = source.tablet_ids ?? source.tabletIds ?? source.tablets;
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw) || raw.length > 2) {
      throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
    }
    const ids: (string | null)[] = [];
    for (const entry of raw) {
      if (entry === null) {
        ids.push(null);
      } else if (typeof entry === "string") {
        ids.push(entry);
      } else {
        const record = recordOf(entry);
        if (record === null) {
          throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
        }
        ids.push(requiredString(record, ["id", "device_id", "deviceId"]));
      }
    }
    return [ids[0] ?? null, ids[1] ?? null];
  }
  return [
    optionalString(source, ["tablet_1", "tablet1"]),
    optionalString(source, ["tablet_2", "tablet2"]),
  ];
}

export function parseTaxi(value: unknown): FleetTaxi {
  const item = recordOf(value);
  if (item === null) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  const active = item.active;
  if (typeof active !== "boolean") {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return {
    id: requiredString(item, ["id", "taxi_id", "taxiId"]),
    displayName: requiredString(item, [
      "display_name",
      "displayName",
      "name",
    ]),
    active,
    revision: revisionOf(item),
    tabletIds: tabletIdsOf(item),
    groupIds: stringArray(item.group_ids ?? item.groupIds),
  };
}

function parseTaxiActivation(value: unknown): TaxiActivationResult {
  const item = recordOf(value);
  if (item === null) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  const active = item.active;
  if (typeof active !== "boolean") {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return { active, revision: revisionOf(item) };
}

function parseTabletActivation(value: unknown): TabletActivationResult {
  const item = recordOf(value);
  if (item === null) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  const active = item.active;
  if (typeof active !== "boolean") {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return { active, revision: revisionOf(item) };
}

function parseTaxiList(value: unknown): FleetTaxi[] {
  const body = recordOf(value);
  if (body === null || !Array.isArray(body.items)) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return body.items.map(parseTaxi);
}

function parseTaxiGroupMembership(value: unknown): TaxiGroupMembership {
  const item = recordOf(value);
  if (item === null) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return {
    taxiId: requiredString(item, ["taxi_id", "taxiId"]),
    groupIds: stringArray(item.group_ids ?? item.groupIds),
    revision: revisionOf(item),
  };
}

function parseGroup(value: unknown): FleetGroup {
  const item = recordOf(value);
  if (item === null) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return {
    id: requiredString(item, ["id", "group_id", "groupId"]),
    name: requiredString(item, ["name", "display_name", "displayName"]),
    revision: revisionOf(item),
  };
}

function parseGroupList(value: unknown): FleetGroup[] {
  const body = recordOf(value);
  if (body === null || !Array.isArray(body.items)) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return body.items.map(parseGroup);
}

function parseTablet(value: unknown): FleetTablet {
  const item = recordOf(value);
  if (item === null) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  const available = item.available;
  const active = item.active ?? item.admin_active;
  if (typeof available !== "boolean" || typeof active !== "boolean") {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return {
    id: requiredString(item, ["id", "device_id", "deviceId"]),
    label: optionalString(item, ["label", "display_name", "displayName"]),
    available,
    active,
    revision: revisionOf(item),
  };
}

function parseTabletList(value: unknown): FleetTablet[] {
  const body = recordOf(value);
  if (body === null || !Array.isArray(body.items)) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return body.items.map(parseTablet);
}

function parseInventory(value: unknown): FleetInventoryItem {
  const item = recordOf(value);
  if (item === null) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  const adminActive = item.admin_active ?? item.adminActive;
  if (typeof adminActive !== "boolean") {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return {
    deviceId: requiredString(item, ["id", "device_id", "deviceId"]),
    serialNumber: optionalString(item, ["serial_number", "serialNumber"]),
    deviceType: optionalString(item, ["device_type", "deviceType"]),
    replacementNote: optionalString(item, [
      "replacement_note",
      "replacementNote",
    ]),
    adminActive,
    revision: revisionOf(item),
  };
}

function parseInventoryList(value: unknown): FleetInventoryItem[] {
  const body = recordOf(value);
  if (body === null || !Array.isArray(body.items)) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return body.items.map(parseInventory);
}

function parsePlayoutPreview(value: unknown): PlayoutPreview {
  const body = recordOf(value);
  if (body === null) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  const taxiId = requiredString(body, ["taxi_id", "taxiId"]);
  // Der explizite Leerzustand der API ist manifest_version: null. Ein
  // ??-Fallback wuerde null als fehlendes Feld behandeln und die gueltige
  // Leerantwort als invalid_response verwerfen; nur undefined faellt zurueck.
  const rawVersion =
    body.manifest_version === undefined
      ? body.manifestVersion
      : body.manifest_version;
  if (
    rawVersion !== null &&
    (typeof rawVersion !== "string" || rawVersion.trim() === "")
  ) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  const rawEntries = body.entries;
  if (!Array.isArray(rawEntries)) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  const entries: PlayoutPreviewEntry[] = rawEntries.map((entry) => {
    const item = recordOf(entry);
    if (item === null) {
      throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
    }
    const durationMs = item.duration_ms ?? item.durationMs;
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
      throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
    }
    return {
      mediaId: requiredString(item, ["media_id", "mediaId"]),
      durationMs,
      startAt: requiredString(item, ["start_at", "startAt"]),
      endAt: requiredString(item, ["end_at", "endAt"]),
    };
  });
  return {
    taxiId,
    manifestVersion: rawVersion === null ? null : rawVersion,
    entries,
  };
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }
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

function createFetchTransport(fetchImpl: FetchLike): FleetTransport {
  return async ({ path, method, body }) => {
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
    try {
      return await fetchImpl(path, init);
    } catch {
      throw new AdminApiError("network", NETWORK_MESSAGE);
    }
  };
}

/**
 * Kleiner Client fuer Taxis, Gruppen, Tablets und Inventar. Saemtliche
 * Operationen sind geschuetzt; eine 401 ruft die zentrale Invalidierung nur
 * dann auf, wenn die beim Start erfasste Sitzungsgeneration noch aktuell ist.
 */
export function createFleetClient(
  options: FleetClientOptions = {},
): FleetClient {
  const baseUrl = options.baseUrl ?? "/v1";
  const transport =
    options.transport ??
    createFetchTransport(
      options.fetchImpl ??
        ((input, init) => {
          return globalThis.fetch(input, init);
        }),
    );
  const onUnauthorized = options.onUnauthorized;
  const getSessionGeneration = options.getSessionGeneration;

  async function request(
    path: string,
    method: "GET" | "POST" | "PATCH" | "PUT",
    body?: unknown,
  ): Promise<unknown> {
    const sessionGeneration = getSessionGeneration?.();
    let response: Response;
    try {
      response = await transport({
        path: joinUrl(baseUrl, path),
        method,
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      if (isAdminApiError(error)) {
        throw error;
      }
      throw new AdminApiError("network", NETWORK_MESSAGE);
    }
    if (!response.ok) {
      if (response.status === 401) {
        const isCurrentSession =
          getSessionGeneration === undefined ||
          sessionGeneration === undefined ||
          getSessionGeneration() === sessionGeneration;
        if (isCurrentSession) {
          onUnauthorized?.();
        }
      }
      throw statusError(response.status);
    }
    return readJson(response);
  }

  return {
    async listTaxis(): Promise<FleetTaxi[]> {
      return parseTaxiList(await request(FLEET_PATHS.taxis, "GET"));
    },

    async getPlayoutPreview(taxiId: string): Promise<PlayoutPreview> {
      return parsePlayoutPreview(
        await request(FLEET_PATHS.playoutPreview(taxiId), "GET"),
      );
    },

    async createTaxi(input: TaxiWriteInput): Promise<FleetTaxi> {
      return parseTaxi(
        await request(FLEET_PATHS.taxis, "POST", {
          id: input.id,
          display_name: input.displayName,
          group_ids: [...input.groupIds],
        }),
      );
    },

    async updateTaxi(id: string, patch: TaxiPatch): Promise<FleetTaxi> {
      return parseTaxi(
        await request(FLEET_PATHS.taxi(id), "PATCH", {
          display_name: patch.displayName,
          group_ids: [...patch.groupIds],
          revision: patch.revision,
        }),
      );
    },

    async assignTablets(
      id: string,
      tabletIds: readonly [string, string],
      revision: number,
    ): Promise<FleetTaxi> {
      return parseTaxi(
        await request(FLEET_PATHS.taxiTablets(id), "PUT", {
          tablet_ids: [tabletIds[0], tabletIds[1]],
          revision,
        }),
      );
    },

    async setTaxiActive(
      id: string,
      active: boolean,
      revision: number,
    ): Promise<TaxiActivationResult> {
      return parseTaxiActivation(
        await request(FLEET_PATHS.taxiActivation(id), "POST", {
          active,
          revision,
        }),
      );
    },

    async setTabletActive(
      id: string,
      active: boolean,
      expectedRevision: number,
    ): Promise<TabletActivationResult> {
      return parseTabletActivation(
        await request(FLEET_PATHS.tabletActivation(id), "PATCH", {
          active,
          expectedRevision,
        }),
      );
    },

    async listGroups(): Promise<FleetGroup[]> {
      return parseGroupList(await request(FLEET_PATHS.groups, "GET"));
    },

    async replaceTaxiGroupMemberships(
      id: string,
      groupIds: readonly string[],
      revision: number,
    ): Promise<TaxiGroupMembership> {
      // Kennungen bleiben eindeutig; die Reihenfolge der bestehenden
      // Zuordnung bleibt erhalten, die neue Gruppe wird hinten angehaengt.
      const unique = [...new Set(groupIds)];
      return parseTaxiGroupMembership(
        await request(FLEET_PATHS.taxiGroups(id), "PUT", {
          group_ids: unique,
          revision,
        }),
      );
    },

    async createGroup(name: string): Promise<FleetGroup> {
      return parseGroup(
        await request(FLEET_PATHS.groups, "POST", { name }),
      );
    },

    async renameGroup(
      id: string,
      name: string,
      revision: number,
    ): Promise<FleetGroup> {
      return parseGroup(
        await request(FLEET_PATHS.group(id), "PATCH", { name, revision }),
      );
    },

    async listTablets(): Promise<FleetTablet[]> {
      return parseTabletList(await request(FLEET_PATHS.tablets, "GET"));
    },

    async listInventory(): Promise<FleetInventoryItem[]> {
      return parseInventoryList(await request(FLEET_PATHS.inventory, "GET"));
    },

    async updateInventoryItem(
      deviceId: string,
      patch: InventoryPatch,
    ): Promise<FleetInventoryItem> {
      const body: Record<string, unknown> = {
        serial_number: patch.serialNumber,
        device_type: patch.deviceType,
        replacement_note: patch.replacementNote,
        revision: patch.revision,
      };
      if (patch.adminActive !== undefined) {
        body.admin_active = patch.adminActive;
      }
      return parseInventory(
        await request(FLEET_PATHS.inventoryItem(deviceId), "PATCH", body),
      );
    },
  };
}

