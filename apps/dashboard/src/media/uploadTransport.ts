/**
 * CX-039 / R-206: injizierbarer Upload-Transport fuer die Medienseite.
 *
 * Der Transport kapselt ausschliesslich den tatsaechlichen XHR-Upload. Er
 * kennt keinen Anmeldezustand und keine CSRF-Token: die vorhandene
 * Cookie-Sitzung wird wie beim Admin-Client same-origin mitgesendet. Der
 * Serververtrag ist der bestehende CX-031-Endpunkt POST /v1/admin/media mit
 * application/octet-stream und optionalem Namen in der Query.
 */

/** Dezimale Obergrenze (1 GB) wie im Serverprofil (MEDIA_UPLOAD_MAX_BYTES). */
export const MEDIA_UPLOAD_MAX_BYTES = 1_000_000_000;

export const MEDIA_UPLOAD_PATH = "/v1/admin/media";

export interface UploadProgress {
  readonly lengthComputable: boolean;
  readonly loaded: number;
  readonly total: number;
}

export interface UploadCompletion {
  readonly status: number;
  readonly responseText: string;
}

export type UploadTransportErrorKind = "network" | "timeout" | "abort";

export interface UploadTransportCallbacks {
  onProgress?(progress: UploadProgress): void;
  /** Die Bytes sind vollstaendig gesendet; die Serverantwort steht noch aus. */
  onUploaded?(): void;
  onComplete?(result: UploadCompletion): void;
  onError?(kind: UploadTransportErrorKind): void;
}

export interface UploadAbortHandle {
  abort(): void;
}

export interface UploadTransport {
  upload(file: File, callbacks: UploadTransportCallbacks): UploadAbortHandle;
}

/** Minimale XHR-Oberflaeche; Tests duerfen sie ersetzen. */
export interface XhrProgressEventLike {
  readonly lengthComputable: boolean;
  readonly loaded: number;
  readonly total: number;
}

export interface UploadXhrLike {
  withCredentials: boolean;
  upload: {
    onprogress: ((event: XhrProgressEventLike) => void) | null;
    onload: (() => void) | null;
  };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  ontimeout: (() => void) | null;
  status: number;
  responseText: string;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Document | XMLHttpRequestBodyInit | null): void;
  abort(): void;
}

export interface XhrUploadTransportOptions {
  /** Basis-Pfad; standardmaessig same-origin "/v1". */
  baseUrl?: string;
  /** Nur fuer deterministische Tests. */
  xhrFactory?: () => UploadXhrLike;
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return base + path;
}

/** Query-Format von CX-031: genau ein optionaler Parameter name. */
export function uploadUrlFor(fileName: string, baseUrl = "/v1"): string {
  return joinUrl(
    baseUrl,
    "/admin/media?name=" + encodeURIComponent(fileName),
  );
}

/**
 * Der einzige produktive Transport. Er wiederholt nichts automatisch und
 * liefert nur Ereignisse, die der Browser tatsaechlich gemeldet hat.
 */
export function createXhrUploadTransport(
  options: XhrUploadTransportOptions = {},
): UploadTransport {
  const baseUrl = options.baseUrl ?? "/v1";
  const xhrFactory =
    options.xhrFactory ??
    (() => new XMLHttpRequest() as unknown as UploadXhrLike);

  return {
    upload(file, callbacks) {
      const xhr = xhrFactory();
      let settled = false;

      xhr.open("POST", uploadUrlFor(file.name, baseUrl));
      // Same-origin wie der Admin-Client: Cookies werden fuer den eigenen
      // Ursprung gesendet; keine eigene Auth und keine Token-Header.
      xhr.withCredentials = false;
      xhr.setRequestHeader("Accept", "application/json");
      xhr.setRequestHeader("Content-Type", "application/octet-stream");

      xhr.upload.onprogress = (event) => {
        if (settled) {
          return;
        }
        callbacks.onProgress?.({
          lengthComputable: event.lengthComputable === true,
          loaded: typeof event.loaded === "number" ? event.loaded : 0,
          total: typeof event.total === "number" ? event.total : 0,
        });
      };
      xhr.upload.onload = () => {
        if (!settled) {
          callbacks.onUploaded?.();
        }
      };
      xhr.onload = () => {
        settled = true;
        callbacks.onComplete?.({
          status: xhr.status,
          responseText: xhr.responseText,
        });
      };
      xhr.onerror = () => {
        settled = true;
        callbacks.onError?.("network");
      };
      xhr.ontimeout = () => {
        settled = true;
        callbacks.onError?.("timeout");
      };
      xhr.onabort = () => {
        settled = true;
        callbacks.onError?.("abort");
      };

      xhr.send(file);

      return {
        abort() {
          if (settled) {
            return;
          }
          // Eigener Abbruch: kein Fehlerereignis mehr an den Aufrufer.
          settled = true;
          xhr.abort();
        },
      };
    },
  };
}
