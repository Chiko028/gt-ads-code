/**
 * CX-039 / R-206: Lesen der vorhandenen Medienliste.
 *
 * Es gibt genau einen Endpunkt und keine neue Backendoperation: GET
 * /v1/admin/media, derselbe Pfad wie der CX-031-Upload. Der Client kennt
 * keinen eigenen Anmeldezustand; er nutzt die same-origin-Cookiesitzung und
 * meldet ausschliesslich 401 an die vorhandene Sitzungsinvalidierung.
 */
import type { FetchLike } from "../admin/adminApi";
import { AdminApiError } from "../admin/adminApi";

export const MEDIA_LIST_PATH = "/v1/admin/media";

export interface MediaListItem {
  readonly id: string;
  readonly name: string | null;
  readonly sizeBytes: number | null;
  readonly durationSeconds: number | null;
  readonly status: string | null;
}

export interface MediaListClientOptions {
  /** Injizierbares fetch; Standard ist das globale fetch. */
  fetchImpl?: FetchLike;
  /** Basis-Pfad; standardmaessig same-origin "/v1". */
  baseUrl?: string;
  /** Wird nur bei 401 aufgerufen. */
  onUnauthorized?: () => void;
}

export interface MediaListClient {
  list(): Promise<MediaListItem[]>;
}

const NETWORK_MESSAGE =
  "Der Server ist nicht erreichbar. Bitte die Verbindung prüfen.";
const INVALID_RESPONSE_MESSAGE = "Die Antwort des Servers war ungültig.";
const UNAUTHORIZED_MESSAGE =
  "Die Sitzung ist abgelaufen. Bitte erneut anmelden.";
const FORBIDDEN_MESSAGE = "Die Aktion ist nicht erlaubt.";
const NOT_FOUND_MESSAGE = "Die Medienliste wurde nicht gefunden.";
const SERVER_MESSAGE =
  "Der Server hat die Medienliste nicht geliefert. Bitte später erneut versuchen.";

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

function firstString(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

function firstNumber(
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

function durationOf(item: Record<string, unknown>): number | null {
  const direct = firstNumber(item, [
    "duration_seconds",
    "durationSeconds",
    "duration",
  ]);
  if (direct !== null) {
    return direct;
  }
  // Das Upload-DTO von CX-031 liefert die Dauer unter profile.
  const profile = recordOf(item.profile);
  if (profile === null) {
    return null;
  }
  return firstNumber(profile, [
    "duration_seconds",
    "durationSeconds",
    "duration",
  ]);
}

function parseItem(value: unknown): MediaListItem {
  const item = recordOf(value);
  if (item === null) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  const id = firstString(item, ["id", "media_id", "mediaId"]);
  if (id === null || id.trim() === "") {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return {
    id,
    name: firstString(item, [
      "name",
      "display_name",
      "displayName",
      "filename",
      "file_name",
    ]),
    sizeBytes: firstNumber(item, ["size_bytes", "sizeBytes", "size"]),
    durationSeconds: durationOf(item),
    status: firstString(item, [
      "status",
      "check_status",
      "checkStatus",
      "review_status",
      "reviewStatus",
      "validation_status",
      "validationStatus",
      "profile_status",
      "profileStatus",
    ]),
  };
}

function parseList(value: unknown): MediaListItem[] {
  const items = Array.isArray(value)
    ? value
    : (() => {
        const body = recordOf(value);
        if (body === null || !Array.isArray(body.items)) {
          return null;
        }
        return body.items;
      })();
  if (items === null) {
    throw new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
  }
  return items.map(parseItem);
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
  if (status === 429) {
    return new AdminApiError(
      "rate_limited",
      "Zu viele Anfragen. Bitte später erneut versuchen.",
      { status },
    );
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

/**
 * Liest die geprüfte Medienliste. Der Client wiederholt nichts automatisch
 * und erfindet keine Status- oder Profilwerte.
 */
export function createMediaListClient(
  options: MediaListClientOptions = {},
): MediaListClient {
  const fetchImpl: FetchLike =
    options.fetchImpl ??
    ((input, init) => {
      return globalThis.fetch(input, init);
    });
  const baseUrl = options.baseUrl ?? "/v1";
  const onUnauthorized = options.onUnauthorized;

  return {
    async list(): Promise<MediaListItem[]> {
      let response: Response;
      try {
        response = await fetchImpl(joinUrl(baseUrl, "/admin/media"), {
          method: "GET",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
      } catch {
        throw new AdminApiError("network", NETWORK_MESSAGE);
      }

      if (!response.ok) {
        if (response.status === 401) {
          onUnauthorized?.();
        }
        throw statusError(response.status);
      }

      return parseList(await readJson(response));
    },
  };
}
