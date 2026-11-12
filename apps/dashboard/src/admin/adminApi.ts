export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type RegistrationCodeStatus =
  | "pending"
  | "used"
  | "expired"
  | "revoked";

export interface RegistrationCode {
  id: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  status: RegistrationCodeStatus;
}

export interface CreatedRegistrationCode {
  id: string;
  code: string;
  label: string | null;
  expiresAt: string;
}

export interface AdminDevice {
  id: string;
  label: string | null;
  manufacturer: string;
  model: string;
  osVersion: string;
  sdkInt: number;
  appVersion: string;
  appFlavor: string;
  state: "active" | "revoked";
  registeredAt: string;
  lastSeenAt: string;
  connectivity: "reachable" | "last_seen";
}

export interface AdminDeviceDetail extends AdminDevice {
  lastClockOffsetMs: number;
  registrationCodeId: string | null;
}

export interface AdminDeviceList {
  serverTime: string;
  onlineThresholdSeconds: number;
  items: AdminDevice[];
  truncated: boolean;
}

export type AdminApiErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "invalid_request"
  | "network"
  | "server"
  | "invalid_response";

export interface AdminApiErrorInit {
  status?: number;
  retryAfterSeconds?: number;
}

/** Bereinigter Fehler des Admin-Clients; die Meldung ist fest und deutsch. */
export class AdminApiError extends Error {
  readonly kind: AdminApiErrorKind;
  readonly status: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    kind: AdminApiErrorKind,
    message: string,
    init: AdminApiErrorInit = {},
  ) {
    super(message);
    this.name = "AdminApiError";
    this.kind = kind;
    this.status = init.status;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

export function isAdminApiError(error: unknown): error is AdminApiError {
  return error instanceof AdminApiError;
}

export function isUnauthorizedError(error: unknown): boolean {
  return isAdminApiError(error) && error.kind === "unauthorized";
}

export interface AdminApi {
  login(password: string): Promise<void>;
  logout(): Promise<void>;
  listRegistrationCodes(): Promise<RegistrationCode[]>;
  createRegistrationCode(label?: string): Promise<CreatedRegistrationCode>;
  revokeRegistrationCode(id: string): Promise<void>;
  listDevices(): Promise<AdminDeviceList>;
  getDevice(id: string): Promise<AdminDeviceDetail>;
  revokeDevice(id: string): Promise<void>;
}

export interface CreateAdminApiOptions {
  /** Injizierbares fetch; Standard ist das globale fetch des Browsers. */
  fetchImpl?: FetchLike;
  /** Basis-Pfad; standardmaessig same-origin "/v1". */
  baseUrl?: string;
  /** Wird nur bei 401 geschuetzter Operationen aufgerufen, nie beim Login. */
  onUnauthorized?: () => void;
}

const NETWORK_MESSAGE =
  "Der Server ist nicht erreichbar. Bitte die Verbindung prüfen.";
const INVALID_RESPONSE_MESSAGE = "Die Antwort des Servers war ungültig.";
const UNAUTHORIZED_MESSAGE =
  "Anmeldung fehlgeschlagen. Bitte das Passwort prüfen.";
const FORBIDDEN_MESSAGE = "Die Aktion ist nicht erlaubt.";
const NOT_FOUND_MESSAGE = "Der Eintrag wurde nicht gefunden.";
const INVALID_REQUEST_MESSAGE = "Die Anfrage ist ungültig.";
const SERVER_MESSAGE =
  "Der Server hat einen Fehler gemeldet. Bitte später erneut versuchen.";

function parseRetryAfter(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const seconds = Number(trimmed);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function errorFromResponse(response: Response): AdminApiError {
  const status = response.status;
  if (status === 429) {
    const retryAfterSeconds = parseRetryAfter(
      response.headers.get("Retry-After"),
    );
    return new AdminApiError(
      "rate_limited",
      retryAfterSeconds === null
        ? "Zu viele Versuche. Bitte später erneut versuchen."
        : `Zu viele Versuche. Bitte in ${retryAfterSeconds} Sekunden erneut versuchen.`,
      {
        status,
        ...(retryAfterSeconds === null ? {} : { retryAfterSeconds }),
      },
    );
  }
  if (status === 401) {
    return new AdminApiError("unauthorized", UNAUTHORIZED_MESSAGE, { status });
  }
  if (status === 403) {
    return new AdminApiError("forbidden", FORBIDDEN_MESSAGE, { status });
  }
  if (status === 404) {
    return new AdminApiError("not_found", NOT_FOUND_MESSAGE, { status });
  }
  if (status === 400) {
    return new AdminApiError("invalid_request", INVALID_REQUEST_MESSAGE, {
      status,
    });
  }
  return new AdminApiError("server", SERVER_MESSAGE, { status });
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }
  const text = await response.text();
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

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function parseRegistrationCode(value: unknown): RegistrationCode {
  const item = recordOf(value);
  const id = item === null ? null : stringField(item, "id");
  const createdAt = item === null ? null : stringField(item, "created_at");
  const expiresAt = item === null ? null : stringField(item, "expires_at");
  const status = item === null ? null : item.status;
  const labelValue = item === null ? null : item.label;
  if (
    item === null ||
    id === null ||
    createdAt === null ||
    expiresAt === null ||
    (labelValue !== null && typeof labelValue !== "string") ||
    (status !== "pending" &&
      status !== "used" &&
      status !== "expired" &&
      status !== "revoked")
  ) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return {
    id,
    label: labelValue,
    createdAt,
    expiresAt,
    status,
  };
}

function parseCreatedCode(value: unknown): CreatedRegistrationCode {
  const item = recordOf(value);
  const id = item === null ? null : stringField(item, "id");
  const code = item === null ? null : stringField(item, "code");
  const expiresAt = item === null ? null : stringField(item, "expires_at");
  const labelValue = item === null ? null : item.label;
  if (
    item === null ||
    id === null ||
    code === null ||
    expiresAt === null ||
    (labelValue !== null && typeof labelValue !== "string")
  ) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return { id, code, label: labelValue, expiresAt };
}

function parseRegistrationCodeList(value: unknown): RegistrationCode[] {
  const body = recordOf(value);
  if (body === null || !Array.isArray(body.items)) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return body.items.map(parseRegistrationCode);
}

function parseDevice(value: unknown): AdminDevice {
  const item = recordOf(value);
  const id = item === null ? null : stringField(item, "id");
  const manufacturer = item === null ? null : stringField(item, "manufacturer");
  const model = item === null ? null : stringField(item, "model");
  const osVersion = item === null ? null : stringField(item, "os_version");
  const appVersion = item === null ? null : stringField(item, "app_version");
  const appFlavor = item === null ? null : stringField(item, "app_flavor");
  const registeredAt = item === null ? null : stringField(item, "registered_at");
  const lastSeenAt = item === null ? null : stringField(item, "last_seen_at");
  const labelValue = item === null ? null : item.label;
  const sdkInt = item === null ? null : item.sdk_int;
  const state = item === null ? null : item.state;
  const connectivity = item === null ? null : item.connectivity;
  if (
    item === null ||
    id === null ||
    manufacturer === null ||
    model === null ||
    osVersion === null ||
    appVersion === null ||
    appFlavor === null ||
    registeredAt === null ||
    lastSeenAt === null ||
    (labelValue !== null && typeof labelValue !== "string") ||
    typeof sdkInt !== "number" ||
    (state !== "active" && state !== "revoked") ||
    (connectivity !== "reachable" && connectivity !== "last_seen")
  ) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return {
    id,
    label: labelValue,
    manufacturer,
    model,
    osVersion,
    sdkInt,
    appVersion,
    appFlavor,
    state,
    registeredAt,
    lastSeenAt,
    connectivity,
  };
}

function parseDeviceList(value: unknown): AdminDeviceList {
  const body = recordOf(value);
  if (
    body === null ||
    !Array.isArray(body.items) ||
    typeof body.server_time !== "string" ||
    typeof body.online_threshold_s !== "number" ||
    (body.truncated !== undefined && typeof body.truncated !== "boolean")
  ) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return {
    serverTime: body.server_time,
    onlineThresholdSeconds: body.online_threshold_s,
    items: body.items.map(parseDevice),
    truncated: body.truncated === true,
  };
}

function parseDeviceDetail(value: unknown): AdminDeviceDetail {
  const item = recordOf(value);
  const device = parseDevice(value);
  const lastClockOffsetMs = item === null ? null : item.last_clock_offset_ms;
  const registrationCodeId = item === null ? null : item.registration_code_id;
  if (
    item === null ||
    typeof lastClockOffsetMs !== "number" ||
    (registrationCodeId !== null && typeof registrationCodeId !== "string")
  ) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return {
    ...device,
    lastClockOffsetMs,
    registrationCodeId,
  };
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return base + path;
}

/**
 * Kleiner HTTP-Client fuer die Admin-API (API-VERTRAG.md v0.1.0, Abschnitte
 * 1, 5 und 7). Der Client verwaltet keine Tokens, wertet keine Cookies aus
 * und wiederholt schreibende Requests nie automatisch.
 */
export function createAdminApi(options: CreateAdminApiOptions = {}): AdminApi {
  const fetchImpl: FetchLike =
    options.fetchImpl ??
    ((input, init) => {
      return globalThis.fetch(input, init);
    });
  const baseUrl = options.baseUrl ?? "/v1";
  const onUnauthorized = options.onUnauthorized;

  async function request(
    path: string,
    method: "GET" | "POST" | "DELETE",
    body: unknown,
    protectedOperation: boolean,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (method === "POST" || method === "DELETE") {
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
      if (response.status === 401 && protectedOperation) {
        onUnauthorized?.();
      }
      throw errorFromResponse(response);
    }
    return response;
  }

  return {
    async login(password: string): Promise<void> {
      await request(
        "/admin/login",
        "POST",
        { password },
        false,
      );
    },

    async logout(): Promise<void> {
      await request("/admin/logout", "POST", undefined, true);
    },

    async listRegistrationCodes(): Promise<RegistrationCode[]> {
      const response = await request(
        "/admin/registration-codes",
        "GET",
        undefined,
        true,
      );
      return parseRegistrationCodeList(await readJson(response));
    },

    async createRegistrationCode(
      label?: string,
    ): Promise<CreatedRegistrationCode> {
      const body = label === undefined ? {} : { label };
      const response = await request(
        "/admin/registration-codes",
        "POST",
        body,
        true,
      );
      return parseCreatedCode(await readJson(response));
    },

    async revokeRegistrationCode(id: string): Promise<void> {
      await request(
        `/admin/registration-codes/${encodeURIComponent(id)}`,
        "DELETE",
        undefined,
        true,
      );
    },

    async listDevices(): Promise<AdminDeviceList> {
      const response = await request("/admin/devices", "GET", undefined, true);
      return parseDeviceList(await readJson(response));
    },

    async getDevice(id: string): Promise<AdminDeviceDetail> {
      const response = await request(
        `/admin/devices/${encodeURIComponent(id)}`,
        "GET",
        undefined,
        true,
      );
      return parseDeviceDetail(await readJson(response));
    },

    async revokeDevice(id: string): Promise<void> {
      await request(
        `/admin/devices/${encodeURIComponent(id)}/revoke`,
        "POST",
        {},
        true,
      );
    },
  };
}

