/**
 * CX-040 / R-207: bewusst lokale Medienvorschau.
 *
 * Es gibt keine neue Auslieferungsroute und keinen Serverdownload. Die
 * Bedienperson waehlt die Originaldatei des bereits gespeicherten Mediums;
 * nur bei passendem SHA-256 entsteht eine Object-URL fuer ein stummes
 * video-Element ohne Autoplay. Die URL wird bei Dateiwechsel, Medienwechsel
 * und Unmount freigegeben.
 */
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";

import { MEDIA_UPLOAD_MAX_BYTES } from "../media/uploadTransport";
import type { MediaOption } from "./campaignApi";

export type PreviewPhase =
  | "idle"
  | "hashing"
  | "match"
  | "mismatch"
  | "oversize"
  | "no_hash"
  | "error";

export interface MediaPreviewProps {
  /** Bereits gespeichertes Medium der Kampagne; null ohne Auswahl. */
  readonly media: MediaOption | null;
}

const NO_MEDIA_MESSAGE = "Zuerst ein Medium auswählen.";
const NO_HASH_MESSAGE =
  "Für dieses Medium ist kein SHA-256 gespeichert; die lokale Vorschau ist nicht möglich.";
const OVERSIZE_MESSAGE =
  "Die Datei ist zu groß. Maximal erlaubt sind 20.000.000 Bytes; sie wird nicht zur Vorschau geladen.";
const MISMATCH_MESSAGE =
  "Die Datei gehört nicht zu diesem Medium (SHA-256 stimmt nicht überein).";
const MATCH_MESSAGE = "Lokale Vorschau: SHA-256 bestätigt.";
const HASH_FAILED_MESSAGE =
  "Die Datei konnte nicht geprüft werden. Die Vorschau bleibt geschlossen.";
const NO_WEBCRYPTO_MESSAGE =
  "SHA-256 ist in dieser Umgebung nicht verfügbar. Die Vorschau bleibt geschlossen.";

/** SHA-256 als hexadezimale Kleinbuchstaben ueber die Browser-Web-Crypto. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error("webcrypto_unavailable");
  }
  const digest = await subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (const byte of view) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Lokale Vorschau. jsdom muss keine Videodekodierung leisten; geprueft
 * werden Dateiauswahl, Hashvergleich, Attribute und URL-Freigabe.
 */
export function MediaPreview({ media }: MediaPreviewProps) {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<PreviewPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  const objectUrlRef = useRef<string | null>(null);
  const aliveRef = useRef(true);
  const hashSeqRef = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function revokeCurrent(): void {
    const current = objectUrlRef.current;
    objectUrlRef.current = null;
    setObjectUrl(null);
    if (current !== null) {
      URL.revokeObjectURL(current);
    }
  }

  function reset(): void {
    hashSeqRef.current += 1;
    revokeCurrent();
    setFile(null);
    setPhase("idle");
    setMessage(null);
    if (inputRef.current !== null) {
      inputRef.current.value = "";
    }
  }

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      hashSeqRef.current += 1;
      const current = objectUrlRef.current;
      objectUrlRef.current = null;
      if (current !== null) {
        URL.revokeObjectURL(current);
      }
    };
  }, []);

  // Medienwechsel: alte URL sofort freigeben und Vorschau zuruecksetzen.
  useEffect(() => {
    reset();
    // reset ist bewusst stabil genug; Abhaengigkeit ist die Medienkennung.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media?.id]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const next = event.target.files?.[0] ?? null;
    const seq = ++hashSeqRef.current;
    revokeCurrent();
    setFile(next);
    setMessage(null);

    if (next === null) {
      setPhase("idle");
      return;
    }
    if (media === null) {
      setPhase("error");
      setMessage(NO_MEDIA_MESSAGE);
      return;
    }
    if (next.size > MEDIA_UPLOAD_MAX_BYTES) {
      setPhase("oversize");
      setMessage(OVERSIZE_MESSAGE);
      return;
    }
    const expected = media.sha256?.trim().toLowerCase() ?? "";
    if (expected === "") {
      setPhase("no_hash");
      setMessage(NO_HASH_MESSAGE);
      return;
    }

    setPhase("hashing");
    setMessage("Datei wird lokal geprüft …");

    void (async () => {
      try {
        const bytes = await next.arrayBuffer();
        if (!aliveRef.current || seq !== hashSeqRef.current) {
          return;
        }
        const actual = (await sha256Hex(bytes)).toLowerCase();
        if (!aliveRef.current || seq !== hashSeqRef.current) {
          return;
        }
        if (actual !== expected) {
          setPhase("mismatch");
          setMessage(MISMATCH_MESSAGE);
          return;
        }
        const url = URL.createObjectURL(next);
        objectUrlRef.current = url;
        setObjectUrl(url);
        setPhase("match");
        setMessage(MATCH_MESSAGE);
      } catch (error) {
        if (!aliveRef.current || seq !== hashSeqRef.current) {
          return;
        }
        setPhase("error");
        setMessage(
          error instanceof Error && error.message === "webcrypto_unavailable"
            ? NO_WEBCRYPTO_MESSAGE
            : HASH_FAILED_MESSAGE,
        );
      }
    })();
  }

  return (
    <fieldset>
      <legend>Medienvorschau (lokal)</legend>
      <p>Es wird nichts vom Server geladen; nur die lokal gewählte Originaldatei wird geprüft.</p>
      <label htmlFor="campaign-preview-file">
        Lokale Originaldatei für Vorschau auswählen
      </label>
      <input
        id="campaign-preview-file"
        ref={inputRef}
        type="file"
        onChange={handleFileChange}
        disabled={media === null}
        accept="video/*"
      />
      <p>Maximal 20.000.000 Bytes.</p>

      {file === null ? (
        <p>Lokale Originaldatei für Vorschau auswählen</p>
      ) : (
        <p>Ausgewählt: {file.name}</p>
      )}

      {phase === "hashing" ? <p role="status">Datei wird lokal geprüft …</p> : null}

      {message !== null && phase !== "hashing" ? (
        <p role={phase === "match" ? "status" : "alert"}>{message}</p>
      ) : null}

      {phase === "match" && objectUrl !== null ? (
        // Stumm, ohne Autoplay, mit sichtbaren Controls.
        <video
          data-testid="media-preview"
          src={objectUrl}
          controls
          muted
          playsInline
          preload="metadata"
        />
      ) : null}
    </fieldset>
  );
}

export default MediaPreview;

