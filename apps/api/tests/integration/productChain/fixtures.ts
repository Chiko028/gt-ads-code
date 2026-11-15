/**
 * CX-063 / R-801: lokale, synthetische Fixtures des Produktkettentests.
 *
 * Alle Werte sind erfunden. Das MP4 ist ein minimales, strukturell lesbares
 * MP4 (ftyp + mdat) und enthaelt keine realen Medieninhalte. Es wird als
 * Datei hochgeladen, damit Hash, Groesse und Range-Verhalten an echten Bytes
 * geprueft werden koennen.
 */
import { createHash, randomUUID } from "node:crypto";

export const BASE_TIME = Date.parse("2026-11-15T12:00:00.000Z");
export const HOST = "127.0.0.1:8080";
export const ORIGIN = "http://" + HOST;
export const ADMIN_PASSWORD = "SYN-CX063-Admin-Passwort";

/** Separater Download-Schluessel; nicht der Registrierungsschluessel. */
export const DOWNLOAD_SECRET = Buffer.from(
  "SYN-CX063-Download-Secret-32-Bytes!!",
  "utf8",
);

export const DEVICE_INFO = {
  manufacturer: "SYN-Hersteller",
  model: "SYN-Modell",
  os_version: "14",
  sdk_int: 34,
  app_version: "0.1.0",
  app_flavor: "dev",
} as const;

export const MEDIA_DURATION_SECONDS = 15;

export function uniqueId(prefix: string): string {
  return prefix + "-" + randomUUID();
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Baut ein minimales synthetisches MP4. Der Inhalt ist deterministisch, damit
 * Erwartungswerte unabhaengig von Zeit und Zufall sind.
 */
export function syntheticMp4(): Buffer {
  const ftyp = Buffer.alloc(28);
  ftyp.writeUInt32BE(28, 0);
  ftyp.write("ftyp", 4, "ascii");
  ftyp.write("isom", 8, "ascii");
  ftyp.writeUInt32BE(0x00000200, 12);
  ftyp.write("isomiso2avc1mp41", 16, "ascii");

  const payload = Buffer.alloc(4096);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = (index * 37 + 11) & 0xff;
  }

  const mdatHeader = Buffer.alloc(8);
  mdatHeader.writeUInt32BE(payload.length + 8, 0);
  mdatHeader.write("mdat", 4, "ascii");

  return Buffer.concat([ftyp, mdatHeader, payload]);
}

export interface SyntheticEvent {
  event_id: string;
  occurred_at: string;
  vehicle_ready: boolean | null;
  paused: boolean | null;
  playback: "playing" | "stopped" | "unknown";
  technical_fault: boolean | null;
}

export function syntheticEvents(count = 2): SyntheticEvent[] {
  return Array.from({ length: count }, (_unused, index) => ({
    event_id: randomUUID(),
    occurred_at: new Date(BASE_TIME + index * 1000).toISOString(),
    vehicle_ready: true,
    paused: false,
    playback: "playing" as const,
    technical_fault: false,
  }));
}
