/**
 * CX-003 / GT-ADS-002: Prüfung serverseitig gelesener Medienmetadaten.
 *
 * Der Eingabedatensatz ist ein bereits normalisierter, interner Datensatz eines
 * späteren serverseitigen Medienlesers. Es handelt sich weder um einen
 * Upload-Request noch um einen Nachweis der Echtheit einer Datei: Diese Funktion
 * prüft ausschließlich Metadaten gegen das Medienprofil und ersetzt keine
 * Binärformatanalyse.
 *
 * Profil (L-01): MP4, H.264, 1920x1080, 30 fps, ohne Audiospur, maximal
 * 1.000.000.000 Byte (dezimale 1.000 MB, einschließlich). 15 Sekunden sind laut
 * L-03 ein Standard und keine harte Uploadgrenze; die Dauer wird daher nur
 * auf Plausibilität geprüft.
 *
 * Die Funktion ist rein: keine Seiteneffekte, keine Mutation der Eingabe, keine
 * I/O, kein Logging.
 */

/** Normalisierte Medienmetadaten eines serverseitigen Medienlesers. */
export interface MediaProfileInput {
  container: string;
  videoCodec: string;
  width: number;
  height: number;
  frameRateNumerator: number;
  frameRateDenominator: number;
  audioStreamCount: number;
  durationSeconds: number;
  sizeBytes: number;
}

/** Stabile Fehlercodes der Profilprüfung. */
export type MediaProfileErrorCode =
  | "invalid_metadata"
  | "unsupported_container"
  | "unsupported_video_codec"
  | "unsupported_resolution"
  | "unsupported_frame_rate"
  | "audio_not_allowed"
  | "file_too_large";

export interface MediaProfileError {
  code: MediaProfileErrorCode;
  field: string;
  message: string;
}

export type MediaProfileResult =
  | { valid: true }
  | { valid: false; errors: MediaProfileError[] };

const REQUIRED_CONTAINER = "mp4";
const REQUIRED_VIDEO_CODEC = "h264";
const REQUIRED_WIDTH = 1920;
const REQUIRED_HEIGHT = 1080;
const REQUIRED_FRAME_RATE = 30;
/**
 * Obergrenze der zulässigen Dateigröße in Byte; die Grenze ist einschließlich.
 * CX-155 / R-202: 1.000.000.000 Byte (dezimale 1.000 MB).
 */
export const MEDIA_MAX_SIZE_BYTES = 1_000_000_000;

type FieldKind = "text" | "positiveInteger" | "nonNegativeInteger" | "positiveNumber";

/**
 * Struktur- und Werttypregeln in fester Feldreihenfolge. Verstöße hier führen
 * ausschließlich zu `invalid_metadata`; die Profilprüfung läuft erst danach.
 */
const FIELD_RULES: ReadonlyArray<{ field: keyof MediaProfileInput; kind: FieldKind }> = [
  { field: "container", kind: "text" },
  { field: "videoCodec", kind: "text" },
  { field: "width", kind: "positiveInteger" },
  { field: "height", kind: "positiveInteger" },
  { field: "frameRateNumerator", kind: "positiveInteger" },
  { field: "frameRateDenominator", kind: "positiveInteger" },
  { field: "audioStreamCount", kind: "nonNegativeInteger" },
  { field: "durationSeconds", kind: "positiveNumber" },
  { field: "sizeBytes", kind: "positiveInteger" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadataError(field: string, message: string): MediaProfileError {
  return { code: "invalid_metadata", field, message };
}

function structureErrors(input: unknown): MediaProfileError[] {
  if (!isRecord(input)) {
    return [
      metadataError(
        "input",
        "Die Metadaten müssen als Objekt mit den Pflichtfeldern vorliegen.",
      ),
    ];
  }

  const errors: MediaProfileError[] = [];

  for (const { field, kind } of FIELD_RULES) {
    const candidate = input[field];

    if (kind === "text") {
      if (typeof candidate !== "string") {
        errors.push(
          metadataError(field, `Pflichtfeld "${field}" fehlt oder ist kein Textwert.`),
        );
      }
      continue;
    }

    if (typeof candidate !== "number") {
      errors.push(
        metadataError(field, `Pflichtfeld "${field}" fehlt oder ist kein Zahlenwert.`),
      );
      continue;
    }

    if (!Number.isFinite(candidate)) {
      errors.push(
        metadataError(field, `Pflichtfeld "${field}" muss eine endliche Zahl sein.`),
      );
      continue;
    }

    if (kind === "positiveInteger" && (!Number.isSafeInteger(candidate) || candidate <= 0)) {
      errors.push(
        metadataError(field, `Pflichtfeld "${field}" muss eine positive ganze Zahl sein.`),
      );
      continue;
    }

    if (kind === "nonNegativeInteger" && (!Number.isSafeInteger(candidate) || candidate < 0)) {
      errors.push(
        metadataError(
          field,
          `Pflichtfeld "${field}" muss eine nicht negative ganze Zahl sein.`,
        ),
      );
      continue;
    }

    if (kind === "positiveNumber" && candidate <= 0) {
      errors.push(
        metadataError(field, `Pflichtfeld "${field}" muss eine positive Zahl sein.`),
      );
    }
  }

  return errors;
}

/** Prüft, ob Zähler und Nenner exakt 30 fps ergeben (z. B. 30/1 und 60/2). */
function frameRateIsThirty(numerator: number, denominator: number): boolean {
  const scaled = denominator * REQUIRED_FRAME_RATE;
  return Number.isSafeInteger(scaled) && numerator === scaled;
}

/**
 * Prüft normalisierte Medienmetadaten gegen das Medienprofil.
 *
 * Bei ungültiger Struktur oder ungültigen Werttypen wird ausschließlich
 * `invalid_metadata` mit den betroffenen Feldern geliefert. Bei strukturell
 * gültiger Eingabe werden alle Profilverletzungen in fester Reihenfolge
 * (Container, Codec, Auflösung, Bildrate, Audio, Größe) gesammelt.
 */
export function validateMediaProfile(input: unknown): MediaProfileResult {
  const structuralErrors = structureErrors(input);
  if (structuralErrors.length > 0) {
    return { valid: false, errors: structuralErrors };
  }

  // Nach der Strukturprüfung sind alle Pflichtfelder vorhanden und typkorrekt.
  const metadata = input as unknown as MediaProfileInput;
  const errors: MediaProfileError[] = [];

  if (metadata.container !== REQUIRED_CONTAINER) {
    errors.push({
      code: "unsupported_container",
      field: "container",
      message: "Der Mediencontainer wird nicht unterstützt; zulässig ist ausschließlich MP4.",
    });
  }

  if (metadata.videoCodec !== REQUIRED_VIDEO_CODEC) {
    errors.push({
      code: "unsupported_video_codec",
      field: "videoCodec",
      message: "Der Videocodec wird nicht unterstützt; zulässig ist ausschließlich H.264.",
    });
  }

  if (metadata.width !== REQUIRED_WIDTH || metadata.height !== REQUIRED_HEIGHT) {
    errors.push({
      code: "unsupported_resolution",
      field: "width,height",
      message: "Die Auflösung wird nicht unterstützt; zulässig ist ausschließlich 1920×1080.",
    });
  }

  if (!frameRateIsThirty(metadata.frameRateNumerator, metadata.frameRateDenominator)) {
    errors.push({
      code: "unsupported_frame_rate",
      field: "frameRateNumerator,frameRateDenominator",
      message: "Die Bildrate wird nicht unterstützt; zulässig sind ausschließlich 30 fps.",
    });
  }

  if (metadata.audioStreamCount !== 0) {
    errors.push({
      code: "audio_not_allowed",
      field: "audioStreamCount",
      message: "Audiospuren sind nicht erlaubt; der Spot muss stumm sein.",
    });
  }

  if (metadata.sizeBytes > MEDIA_MAX_SIZE_BYTES) {
    errors.push({
      code: "file_too_large",
      field: "sizeBytes",
      message: "Die Dateigröße überschreitet die zulässigen 1.000 MB.",
    });
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}
