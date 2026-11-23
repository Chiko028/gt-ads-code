/**
 * App-Updates aus der Ferne: Client fuer
 *   GET   /v1/admin/app-releases
 *   POST  /v1/admin/app-releases?version_code=&version_name=&sha256=&notes=  (APK als application/octet-stream)
 *   PATCH /v1/admin/app-releases/:id               {rollout}
 *   PATCH /v1/admin/devices/:id/update-channel     {update_channel}
 * Same-origin-Sitzung wie die uebrigen Dashboard-Clients. Felder wie in CX-168 (apps/api/src/http/appReleaseRoutes.ts).
 */
import type { FetchLike } from "../admin/adminApi";

export type Rollout = "none" | "pilot" | "all";
export type UpdateChannel = "stable" | "pilot";

export interface AppRelease {
  readonly id: string;
  readonly versionCode: number;
  readonly versionName: string;
  readonly notes: string;
  readonly sizeBytes: number;
  readonly rollout: Rollout;
  readonly createdAt: string;
  readonly counts: { readonly installed: number; readonly downloaded: number; readonly failed: number };
}

export interface DeviceUpdateRow {
  readonly id: string;
  readonly label: string | null;
  readonly osVersion: string;
  readonly state: string;
  readonly taxiId: string | null;
  readonly taxiName: string | null;
  readonly updateChannel: UpdateChannel;
  readonly appVersion: string;
  readonly lastReport: {
    readonly versionCode: number;
    readonly versionName: string;
    readonly status: "downloaded" | "installed" | "failed";
    readonly detail: string | null;
    readonly reportedAt: string;
  } | null;
}

export interface AppUpdatesOverview {
  readonly releases: readonly AppRelease[];
  readonly devices: readonly DeviceUpdateRow[];
}

export interface UploadInput {
  readonly file: Blob;
  readonly versionCode: string;
  readonly versionName: string;
  readonly notes: string;
}

export class AppUpdatesError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "AppUpdatesError";
  }
}

export interface AppUpdatesClient {
  overview(): Promise<AppUpdatesOverview>;
  upload(input: UploadInput): Promise<void>;
  setRollout(releaseId: string, rollout: Rollout): Promise<void>;
  setChannel(deviceId: string, channel: UpdateChannel): Promise<void>;
}

function invalid(): never {
  throw new AppUpdatesError("Die Antwort des Servers ist ungültig.", 0);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string") invalid();
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalid();
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid();
  return value as T;
}

export function parseOverview(value: unknown): AppUpdatesOverview {
  const body = record(value);
  return {
    releases: list(body.releases).map((entry) => {
      const row = record(entry);
      return {
        id: text(row.id),
        versionCode: count(row.version_code),
        versionName: text(row.version_name),
        notes: nullableText(row.notes) ?? "",
        sizeBytes: count(row.size_bytes),
        rollout: oneOf(row.rollout, ["none", "pilot", "all"] as const),
        createdAt: text(row.created_at),
        counts: { installed: count(row.installed), downloaded: count(row.downloaded), failed: count(row.failed) },
      };
    }),
    devices: list(body.devices).map((entry) => {
      const row = record(entry);
      const report = row.last_report === null ? null : record(row.last_report);
      return {
        id: text(row.device_id),
        label: nullableText(row.label),
        osVersion: text(row.os_version),
        state: text(row.state),
        taxiId: nullableText(row.taxi_id),
        taxiName: nullableText(row.taxi_name),
        updateChannel: oneOf(row.update_channel, ["stable", "pilot"] as const),
        appVersion: text(row.app_version),
        lastReport:
          report === null
            ? null
            : {
                versionCode: count(report.version_code),
                versionName: text(report.version_name),
                status: oneOf(report.status, ["downloaded", "installed", "failed"] as const),
                detail: nullableText(report.detail),
                reportedAt: text(report.reported_at),
              },
      };
    }),
  };
}

/** Verstaendliche Meldung je HTTP-Status. */
export function messageFor(status: number, action: "upload" | "change" | "load"): string {
  if (status === 401) return "Die Sitzung ist abgelaufen. Bitte neu anmelden.";
  if (status === 403) return "Keine Berechtigung. App-Updates darf nur ein Admin verwalten.";
  if (status === 404) return "Eintrag nicht gefunden. Bitte die Liste aktualisieren.";
  if (status === 409 && action === "upload") {
    return "Diese Version ist schon vorhanden: Die Versionsnummer muss höher sein als alle bisherigen und der Versionsname neu.";
  }
  if (status === 413) return "Die Datei ist zu groß (höchstens 200 MB).";
  if (status === 400 || status === 415) {
    return action === "upload"
      ? "Ungültige Angaben: Bitte eine APK-Datei, eine ganze Versionsnummer (z. B. 3) und einen Versionsnamen (z. B. 0.3.0) angeben."
      : "Ungültige Anfrage.";
  }
  if (status === 0) return "Server nicht erreichbar.";
  return "Unerwarteter Fehler (" + status + ").";
}

/** SHA-256 der Datei als Kleinbuchstaben-Hex (der Server prueft ihn gegen die hochgeladenen Bytes). */
export async function sha256Hex(file: Blob): Promise<string> {
  const bytes =
    typeof file.arrayBuffer === "function" ? await file.arrayBuffer() : await new Response(file).arrayBuffer();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createAppUpdatesClient(options: { fetchImpl?: FetchLike; baseUrl?: string } = {}): AppUpdatesClient {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const base = (options.baseUrl ?? "/v1").replace(/\/$/, "");

  async function send(
    path: string,
    init: RequestInit,
    action: "upload" | "change" | "load",
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(base + path, { credentials: "same-origin", ...init });
    } catch {
      throw new AppUpdatesError(messageFor(0, action), 0);
    }
    if (!response.ok) throw new AppUpdatesError(messageFor(response.status, action), response.status);
    return response;
  }

  async function patch(path: string, body: unknown): Promise<void> {
    await send(
      path,
      {
        method: "PATCH",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      "change",
    );
  }

  return {
    async overview() {
      const response = await send("/admin/app-releases", { method: "GET", headers: { Accept: "application/json" } }, "load");
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        invalid();
      }
      return parseOverview(value);
    },
    async upload(input) {
      let sha256: string;
      try {
        sha256 = await sha256Hex(input.file);
      } catch {
        throw new AppUpdatesError("Die Datei konnte nicht gelesen werden.", 0);
      }
      const query = new URLSearchParams({
        version_code: input.versionCode.trim(),
        version_name: input.versionName.trim(),
        sha256,
      });
      if (input.notes.trim() !== "") query.set("notes", input.notes.trim());
      await send(
        "/admin/app-releases?" + query.toString(),
        { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/octet-stream" }, body: input.file },
        "upload",
      );
    },
    setRollout(releaseId, rollout) {
      return patch("/admin/app-releases/" + encodeURIComponent(releaseId), { rollout });
    },
    setChannel(deviceId, channel) {
      return patch("/admin/devices/" + encodeURIComponent(deviceId) + "/update-channel", { update_channel: channel });
    },
  };
}
