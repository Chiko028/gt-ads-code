import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChangeEvent, FormEvent } from "react";

import type { FetchLike } from "../admin/adminApi";
import { isAdminApiError, isUnauthorizedError } from "../admin/adminApi";
import { useAdminSession } from "../admin/AdminShell";
import type { MediaListItem } from "./mediaListApi";
import { createMediaListClient } from "./mediaListApi";
import type {
  UploadAbortHandle,
  UploadCompletion,
  UploadProgress,
  UploadTransport,
  UploadTransportErrorKind,
} from "./uploadTransport";
import { createXhrUploadTransport } from "./uploadTransport";

const UNKNOWN = "Unbekannt";
const UNEXPECTED_MESSAGE = "Ein unerwarteter Fehler ist aufgetreten.";
const NO_FILE_MESSAGE = "Bitte zuerst eine Datei auswählen.";
/**
 * CX-158 / R-206: exakte Obergrenze des Medienprofils (CX-155 / R-202, L-01),
 * einschliesslich. Der Wert entspricht serverseitig MEDIA_MAX_SIZE_BYTES;
 * das Servermodul wird bewusst nicht in das Browser-Bundle importiert.
 * Bewusst nicht der 20-MB-Wert der lokalen Kampagnenvorschau (CX-040),
 * die eine andere Funktion erfuellt. Die Pruefung hier ist nur eine
 * Vorab-Rueckmeldung; die abschliessende Ablehnung bleibt beim Server (z. B. 413).
 */
export const MEDIA_UPLOAD_PROFILE_MAX_BYTES = 1_000_000_000;

/** Bytezahl mit deutschen Tausenderpunkten, ohne Intl-Abhaengigkeit. */
function groupThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

const OVERSIZE_MESSAGE = `Die Datei ist zu groß. Maximal erlaubt sind ${groupThousands(
  MEDIA_UPLOAD_PROFILE_MAX_BYTES,
)} Bytes; sie wurde nicht gesendet.`;
const INVALID_UPLOAD_RESPONSE =
  "Die Upload-Antwort des Servers war ungültig. Ein Erfolg ist nicht bestätigt.";
const UNCLEAR_UPLOAD_MESSAGE =
  "Der Ausgang des Uploads ist unklar. Die Datei wurde möglicherweise übertragen; es wird nicht automatisch wiederholt.";
const ABORTED_UPLOAD_MESSAGE = "Der Upload wurde abgebrochen.";
const LIST_FAILED_MESSAGE = "Die Medienliste konnte nicht geladen werden.";
const RELOAD_AFTER_UPLOAD_FAILED =
  "Der Upload wurde bestätigt, aber die Medienliste konnte nicht aktualisiert werden.";

type UploadPhase = "idle" | "uploading" | "checking" | "success" | "error";

export interface MediaPageProps {
  /** Injizierbares fetch fuer die Medienliste (Tests/App). */
  readonly fetchImpl?: FetchLike;
  /**
   * Injizierbarer Upload-Transport. Ersetzt ausschliesslich den XHR-Weg;
   * die Sitzung bleibt die vorhandene Cookie-Sitzung der AdminShell.
   */
  readonly uploadTransport?: UploadTransport;
}

interface ConfirmedUpload {
  readonly id: string;
  readonly name: string;
}

function messageFor(error: unknown): string {
  return isAdminApiError(error) ? error.message : UNEXPECTED_MESSAGE;
}

function statusLabel(status: string | null): string {
  if (status === null || status.trim() === "") {
    return UNKNOWN;
  }
  const normalized = status.trim().toLowerCase();
  if (
    normalized === "ready" ||
    normalized === "checked" ||
    normalized === "valid" ||
    normalized === "approved" ||
    normalized === "verified"
  ) {
    return "Geprüft";
  }
  if (
    normalized === "pending" ||
    normalized === "checking" ||
    normalized === "processing" ||
    normalized === "queued"
  ) {
    return "Wird geprüft";
  }
  if (
    normalized === "rejected" ||
    normalized === "invalid" ||
    normalized === "failed" ||
    normalized === "error"
  ) {
    return "Abgelehnt";
  }
  // Unbekannte Serverwerte werden unveraendert gezeigt, nie als Erfolg.
  return status;
}

function uploadErrorForStatus(status: number): string {
  if (status === 413) {
    return `Der Server hat die Datei als zu groß abgelehnt (413). Maximal erlaubt sind ${groupThousands(
      MEDIA_UPLOAD_PROFILE_MAX_BYTES,
    )} Bytes.`;
  }
  if (status === 415) {
    return "Der Server hat den Dateityp abgelehnt (415).";
  }
  if (status === 422) {
    return "Der Server hat die Datei als ungültiges Medienformat abgelehnt (422). Erlaubt: MP4 (H.264), 1920×1080, 30 fps, ohne Ton, 5 bis 60 Sekunden.";
  }
  if (status === 400) {
    return "Die Upload-Anfrage wurde vom Server als ungültig abgelehnt (400).";
  }
  if (status === 403) {
    return "Der Upload ist nicht erlaubt (403).";
  }
  if (status === 404) {
    return "Der Upload-Endpunkt wurde nicht gefunden (404).";
  }
  if (status === 429) {
    return "Zu viele Uploads. Bitte später erneut versuchen (429).";
  }
  if (status >= 500) {
    return `Der Server konnte den Upload nicht verarbeiten (Status ${status}). Bitte später erneut versuchen.`;
  }
  return `Der Upload wurde vom Server abgelehnt (Status ${status}).`;
}

function uploadErrorForTransport(kind: UploadTransportErrorKind): string {
  if (kind === "abort") {
    return ABORTED_UPLOAD_MESSAGE;
  }
  return UNCLEAR_UPLOAD_MESSAGE;
}

function parseUploadResponse(
  responseText: string,
  fallbackName: string,
): ConfirmedUpload | null {
  let body: unknown;
  try {
    body = JSON.parse(responseText) as unknown;
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim() === "") {
    return null;
  }
  const name =
    typeof record.name === "string" && record.name.trim() !== ""
      ? record.name
      : fallbackName;
  return { id: record.id, name };
}

function percentOf(progress: UploadProgress): number {
  const ratio = progress.loaded / progress.total;
  if (!Number.isFinite(ratio)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

/**
 * Medienseite (R-206): Upload ueber den vorhandenen CX-031-Endpunkt,
 * echte XHR-Fortschritte, getrennte Serverpruefung und eine Liste aus dem
 * vorhandenen Lese-Endpunkt. Es gibt keinen zweiten Anmeldezustand; die
 * Sitzung kommt ausschliesslich aus der AdminShell.
 */
export function MediaPage({ fetchImpl, uploadTransport }: MediaPageProps) {
  const { invalidateSession } = useAdminSession();

  const [items, setItems] = useState<MediaListItem[] | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [reloadWarning, setReloadWarning] = useState<string | null>(null);

  const aliveRef = useRef(true);
  const listSeqRef = useRef(0);
  const uploadBusyRef = useRef(false);
  const uploadHandleRef = useRef<UploadAbortHandle | null>(null);

  const transport = useMemo(
    () => uploadTransport ?? createXhrUploadTransport(),
    [uploadTransport],
  );

  const listClient = useMemo(
    () => createMediaListClient({ fetchImpl }),
    [fetchImpl],
  );

  const loadList = useCallback(async (): Promise<boolean> => {
    const seq = ++listSeqRef.current;
    setListLoading(true);
    setListError(null);
    try {
      const loaded = await listClient.list();
      if (!aliveRef.current || seq !== listSeqRef.current) {
        return false;
      }
      setItems(loaded);
      return true;
    } catch (error) {
      if (!aliveRef.current || seq !== listSeqRef.current) {
        return false;
      }
      // 401 invalidiert die vorhandene Sitzung. Der alive-Check oben
      // verwirft spaete Antworten einer bereits abgemeldeten Seite.
      if (isUnauthorizedError(error)) {
        invalidateSession();
        return false;
      }
      setListError(messageFor(error));
      return false;
    } finally {
      if (aliveRef.current && seq === listSeqRef.current) {
        setListLoading(false);
      }
    }
  }, [invalidateSession, listClient]);

  useEffect(() => {
    aliveRef.current = true;
    void loadList();
    return () => {
      aliveRef.current = false;
      listSeqRef.current += 1;
      uploadBusyRef.current = false;
      const handle = uploadHandleRef.current;
      uploadHandleRef.current = null;
      // Abmeldung oder Unmount bricht den laufenden Upload ab. Spaete
      // Antworten werden ueber aliveRef verworfen.
      handle?.abort();
    };
  }, [loadList]);

  const finishUpload = useCallback(
    async (result: UploadCompletion, file: File): Promise<void> => {
      if (!aliveRef.current) {
        return;
      }
      uploadBusyRef.current = false;
      uploadHandleRef.current = null;

      if (result.status === 401) {
        // Vorhandene Sitzung invalidieren; kein lokaler Erfolg, keine Liste.
        setPhase("error");
        setProgress(null);
        invalidateSession();
        return;
      }

      if (result.status < 200 || result.status >= 300) {
        setPhase("error");
        setProgress(null);
        setUploadError(uploadErrorForStatus(result.status));
        return;
      }

      const confirmed = parseUploadResponse(result.responseText, file.name);
      if (confirmed === null) {
        setPhase("error");
        setProgress(null);
        setUploadError(INVALID_UPLOAD_RESPONSE);
        return;
      }

      setPhase("success");
      setProgress(null);
      setUploadError(null);
      setUploadSuccess(`Upload bestätigt: ${confirmed.name} (ID ${confirmed.id})`);

      // Erst die bestaetigte Uploadantwort loest das Nachladen aus.
      const reloaded = await loadList();
      if (!aliveRef.current) {
        return;
      }
      if (!reloaded) {
        setReloadWarning(RELOAD_AFTER_UPLOAD_FAILED);
      }
    },
    [invalidateSession, loadList],
  );

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setPhase("idle");
    setProgress(null);
    setUploadError(null);
    setUploadSuccess(null);
    setReloadWarning(null);
  }

  function handleUpload(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (uploadBusyRef.current) {
      return;
    }
    const file = selectedFile;
    if (file === null) {
      setPhase("error");
      setUploadError(NO_FILE_MESSAGE);
      return;
    }
    // Die exakte CX-155-Profilgrenze wird vor dem Versand geprueft.
    if (file.size > MEDIA_UPLOAD_PROFILE_MAX_BYTES) {
      setPhase("error");
      setProgress(null);
      setUploadSuccess(null);
      setReloadWarning(null);
      setUploadError(OVERSIZE_MESSAGE);
      return;
    }

    uploadBusyRef.current = true;
    setPhase("uploading");
    setProgress(null);
    setUploadError(null);
    setUploadSuccess(null);
    setReloadWarning(null);

    let handle: UploadAbortHandle;
    try {
      handle = transport.upload(file, {
        onProgress: (next) => {
          if (!aliveRef.current) {
            return;
          }
          setProgress(next);
          if (
            next.lengthComputable &&
            next.total > 0 &&
            next.loaded >= next.total
          ) {
            setPhase("checking");
          }
        },
        onUploaded: () => {
          if (!aliveRef.current) {
            return;
          }
          setPhase((current) =>
            current === "uploading" ? "checking" : current,
          );
        },
        onComplete: (result) => {
          void finishUpload(result, file);
        },
        onError: (kind) => {
          if (!aliveRef.current) {
            return;
          }
          uploadBusyRef.current = false;
          uploadHandleRef.current = null;
          setPhase("error");
          setProgress(null);
          setUploadError(uploadErrorForTransport(kind));
        },
      });
    } catch {
      uploadBusyRef.current = false;
      setPhase("error");
      setProgress(null);
      setUploadError(UNCLEAR_UPLOAD_MESSAGE);
      return;
    }
    uploadHandleRef.current = handle;
  }

  const busy = phase === "uploading" || phase === "checking";
  const determinate =
    progress !== null && progress.lengthComputable && progress.total > 0;
  const percent = determinate && progress !== null ? percentOf(progress) : null;

  return (
    <section aria-label="Medien">
      <h2>Medien</h2>

      <form onSubmit={handleUpload} noValidate>
        <label htmlFor="media-file">Datei</label>
        <input
          id="media-file"
          name="file"
          type="file"
          onChange={handleFileChange}
          disabled={busy}
        />
        <button type="submit" disabled={busy || selectedFile === null}>
          Hochladen
        </button>
      </form>
      <p>Maximal {groupThousands(MEDIA_UPLOAD_PROFILE_MAX_BYTES)} Bytes pro Datei.</p>

      {phase === "uploading" ? (
        determinate && percent !== null ? (
          <div>
            <p role="status">{percent} % übertragen</p>
            <progress max={100} value={percent} />
          </div>
        ) : (
          <p role="status">
            Wird hochgeladen … (Fortschritt unbekannt)
          </p>
        )
      ) : null}

      {phase === "checking" ? (
        <div>
          {determinate && percent !== null ? (
            <p>{percent} % übertragen</p>
          ) : null}
          <p role="status">Wird geprüft …</p>
        </div>
      ) : null}

      {uploadSuccess !== null ? (
        <p role="status">{uploadSuccess}</p>
      ) : null}
      {reloadWarning !== null ? <p role="alert">{reloadWarning}</p> : null}
      {uploadError !== null ? <p role="alert">{uploadError}</p> : null}

      <div>
        <button
          type="button"
          onClick={() => {
            setReloadWarning(null);
            void loadList();
          }}
          disabled={listLoading || busy}
        >
          Liste aktualisieren
        </button>
      </div>

      {listLoading ? <p>Medien werden geladen …</p> : null}

      {listError !== null ? (
        <div role="alert">
          <p>{LIST_FAILED_MESSAGE}</p>
          <p>{listError}</p>
        </div>
      ) : null}

      {items !== null &&
      items.length === 0 &&
      !listLoading &&
      listError === null ? (
        <p>Keine Medien vorhanden.</p>
      ) : null}

      {items !== null && items.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Medienkennung</th>
              <th scope="col">Dateiname</th>
              <th scope="col">Größe</th>
              <th scope="col">Dauer</th>
              <th scope="col">Prüfstatus</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.id}</td>
                <td>{item.name ?? UNKNOWN}</td>
                <td>
                  {item.sizeBytes === null
                    ? UNKNOWN
                    : `${item.sizeBytes} Bytes`}
                </td>
                <td>
                  {item.durationSeconds === null
                    ? UNKNOWN
                    : `${item.durationSeconds} s`}
                </td>
                <td>{statusLabel(item.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

export default MediaPage;
