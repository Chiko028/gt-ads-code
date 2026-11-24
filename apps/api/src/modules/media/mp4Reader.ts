/**
 * L-01: serverseitiger Leser fuer MP4-Metadaten (ISO-BMFF).
 *
 * Liest ausschliesslich die Kopfstrukturen (ftyp, moov/mvhd, trak/tkhd,
 * mdia/mdhd/hdlr, stbl/stsd/stts) per wahlfreiem Zugriff aus der bereits
 * gespeicherten Datei. Die Nutzdaten (mdat) werden nie gelesen; auch eine
 * 1000-MB-Datei belegt daher nur wenige Kilobyte Speicher.
 *
 * Ergebnis ist ein Rohdatensatz fuer validateMediaProfile (ohne sizeBytes,
 * die stammen aus den tatsaechlich empfangenen Bytes). Ist die Datei kein
 * lesbares MP4, liefert der Leser undefined; die Profilpruefung lehnt dann
 * mit invalid_metadata ab. Der Leser wirft nie wegen des Dateiinhalts.
 */
import { open, type FileHandle } from "node:fs/promises";

/** Vom Leser ermittelte Profilfelder (ohne sizeBytes). */
export interface Mp4Metadata {
  container: string;
  videoCodec: string;
  width: number;
  height: number;
  frameRateNumerator: number;
  frameRateDenominator: number;
  audioStreamCount: number;
  durationSeconds: number;
}

/** Marken der MP4-Familie (ISO/IEC 14496-12/-14/-15). */
const MP4_BRANDS = new Set([
  "isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso7", "iso8", "iso9",
  "mp41", "mp42", "mp71", "avc1", "M4V ", "M4VP", "f4v ", "dash", "msnv",
]);

const MAX_DEPTH = 8;
const MAX_BOXES = 10_000;
/** Kleine Kopfboxen (mvhd, tkhd, mdhd, hdlr). */
const SMALL_BOX_LIMIT = 64 * 1024;
const STSD_LIMIT = 1024 * 1024;
/** stts: 8 Byte je Eintrag; 16 MB reichen fuer ~2 Mio. Wechsel. */
const STTS_LIMIT = 16 * 1024 * 1024;

const CONTAINER_TYPES = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

class Mp4FormatError extends Error {}

interface Box {
  type: string;
  /** Beginn der Nutzlast (nach dem Kopf). */
  start: number;
  /** Ende der Box (exklusiv). */
  end: number;
}

interface TrackInfo {
  handler: string;
  timescale: number;
  duration: number;
  codec: string | null;
  width: number;
  height: number;
  stts: Array<{ count: number; delta: number }>;
}

class BoxReader {
  private boxes = 0;

  constructor(
    private readonly handle: FileHandle,
    readonly fileSize: number,
  ) {}

  async read(position: number, length: number): Promise<Buffer> {
    if (length < 0 || position < 0 || position + length > this.fileSize) {
      throw new Mp4FormatError("Lesebereich ausserhalb der Datei.");
    }
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await this.handle.read(
        buffer,
        offset,
        length - offset,
        position + offset,
      );
      if (bytesRead <= 0) {
        throw new Mp4FormatError("Datei endet vorzeitig.");
      }
      offset += bytesRead;
    }
    return buffer;
  }

  /** Listet die direkten Kindboxen im Bereich [start, end). */
  async children(start: number, end: number): Promise<Box[]> {
    const result: Box[] = [];
    let position = start;
    while (position + 8 <= end) {
      this.boxes += 1;
      if (this.boxes > MAX_BOXES) {
        throw new Mp4FormatError("Zu viele Boxen.");
      }
      const header = await this.read(position, 8);
      let size = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      let headerSize = 8;
      if (size === 1) {
        if (position + 16 > end) throw new Mp4FormatError("Kopf unvollstaendig.");
        const large = (await this.read(position + 8, 8)).readBigUInt64BE(0);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Mp4FormatError("Box zu gross.");
        }
        size = Number(large);
        headerSize = 16;
      } else if (size === 0) {
        size = end - position;
      }
      if (size < headerSize || position + size > end) {
        throw new Mp4FormatError("Ungueltige Boxgroesse.");
      }
      result.push({ type, start: position + headerSize, end: position + size });
      position += size;
    }
    return result;
  }

  async payload(box: Box, limit: number): Promise<Buffer> {
    const length = box.end - box.start;
    if (length > limit) {
      throw new Mp4FormatError(`Box ${box.type} ist zu gross.`);
    }
    return this.read(box.start, length);
  }
}

function need(buffer: Buffer, length: number): void {
  if (buffer.length < length) {
    throw new Mp4FormatError("Box ist zu kurz.");
  }
}

/** mvhd/mdhd: Zeitskala und Dauer fuer Version 0 und 1. */
function parseTimeHeader(buffer: Buffer): { timescale: number; duration: number } {
  need(buffer, 4);
  const version = buffer.readUInt8(0);
  if (version === 1) {
    need(buffer, 32);
    const duration = buffer.readBigUInt64BE(24);
    return {
      timescale: buffer.readUInt32BE(20),
      // 0xFFFF... bedeutet "unbekannt".
      duration:
        duration >= BigInt(Number.MAX_SAFE_INTEGER) ? 0 : Number(duration),
    };
  }
  need(buffer, 20);
  const duration = buffer.readUInt32BE(16);
  return {
    timescale: buffer.readUInt32BE(12),
    duration: duration === 0xffffffff ? 0 : duration,
  };
}

function parseHandler(buffer: Buffer): string {
  need(buffer, 12);
  return buffer.toString("latin1", 8, 12);
}

/** Erster Eintrag der Sample-Beschreibung: Codec und kodierte Aufloesung. */
function parseStsd(buffer: Buffer): { codec: string; width: number; height: number } | null {
  need(buffer, 8);
  if (buffer.readUInt32BE(4) < 1 || buffer.length < 16) {
    return null;
  }
  const entryType = buffer.toString("latin1", 12, 16);
  let width = 0;
  let height = 0;
  // VisualSampleEntry: Kopf 8, reserviert 6, dref 2, pre_defined/reserved 16,
  // danach width (16 Bit) und height (16 Bit).
  if (buffer.length >= 8 + 36) {
    width = buffer.readUInt16BE(8 + 32);
    height = buffer.readUInt16BE(8 + 34);
  }
  return { codec: normalizeCodec(entryType), width, height };
}

function normalizeCodec(entryType: string): string {
  if (entryType === "avc1" || entryType === "avc3") return "h264";
  if (entryType === "hvc1" || entryType === "hev1") return "h265";
  return entryType.trim().toLowerCase();
}

function parseStts(buffer: Buffer): Array<{ count: number; delta: number }> {
  need(buffer, 8);
  const entryCount = buffer.readUInt32BE(4);
  need(buffer, 8 + entryCount * 8);
  const entries: Array<{ count: number; delta: number }> = [];
  for (let index = 0; index < entryCount; index += 1) {
    const offset = 8 + index * 8;
    entries.push({
      count: buffer.readUInt32BE(offset),
      delta: buffer.readUInt32BE(offset + 4),
    });
  }
  return entries;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    [x, y] = [y, x % y];
  }
  return x;
}

/**
 * Bildrate als gekuerzter Bruch. Konstante Bildrate: timescale/delta. Ein
 * abweichender letzter Einzelwert (haeufig beim letzten Frame) wird ignoriert.
 * Sonst (variable Bildrate) der exakte Mittelwert Frames*timescale/Dauer,
 * der in der Praxis nicht genau 30 ergibt und daher abgelehnt wird.
 */
export function frameRateOf(
  timescale: number,
  stts: ReadonlyArray<{ count: number; delta: number }>,
): { numerator: number; denominator: number } | null {
  let entries = stts.filter((entry) => entry.count > 0);
  if (timescale <= 0 || entries.length === 0) {
    return null;
  }
  if (entries.length > 1 && entries[entries.length - 1]?.count === 1) {
    entries = entries.slice(0, -1);
  }
  const firstDelta = entries[0]?.delta ?? 0;
  let numerator: number;
  let denominator: number;
  if (entries.every((entry) => entry.delta === firstDelta)) {
    numerator = timescale;
    denominator = firstDelta;
  } else {
    let frames = 0;
    let ticks = 0;
    for (const entry of entries) {
      frames += entry.count;
      ticks += entry.count * entry.delta;
    }
    numerator = frames * timescale;
    denominator = ticks;
  }
  if (
    denominator <= 0 ||
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator)
  ) {
    return null;
  }
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

async function readTrack(reader: BoxReader, trak: Box): Promise<TrackInfo> {
  const info: TrackInfo = {
    handler: "",
    timescale: 0,
    duration: 0,
    codec: null,
    width: 0,
    height: 0,
    stts: [],
  };

  async function walk(start: number, end: number, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) {
      throw new Mp4FormatError("Verschachtelung zu tief.");
    }
    for (const box of await reader.children(start, end)) {
      if (CONTAINER_TYPES.has(box.type)) {
        await walk(box.start, box.end, depth + 1);
      } else if (box.type === "mdhd") {
        const header = parseTimeHeader(await reader.payload(box, SMALL_BOX_LIMIT));
        info.timescale = header.timescale;
        info.duration = header.duration;
      } else if (box.type === "hdlr") {
        info.handler = parseHandler(await reader.payload(box, SMALL_BOX_LIMIT));
      } else if (box.type === "stsd") {
        const entry = parseStsd(await reader.payload(box, STSD_LIMIT));
        if (entry !== null) {
          info.codec = entry.codec;
          info.width = entry.width;
          info.height = entry.height;
        }
      } else if (box.type === "stts") {
        info.stts = parseStts(await reader.payload(box, STTS_LIMIT));
      }
    }
  }

  await walk(trak.start, trak.end, 1);
  return info;
}

async function parse(reader: BoxReader): Promise<Mp4Metadata | undefined> {
  const top = await reader.children(0, reader.fileSize);
  const ftyp = top.find((box) => box.type === "ftyp");
  const moov = top.find((box) => box.type === "moov");
  if (ftyp === undefined || moov === undefined) {
    return undefined;
  }

  const ftypBytes = await reader.payload(ftyp, SMALL_BOX_LIMIT);
  need(ftypBytes, 8);
  const brands = [ftypBytes.toString("latin1", 0, 4)];
  for (let offset = 8; offset + 4 <= ftypBytes.length; offset += 4) {
    brands.push(ftypBytes.toString("latin1", offset, offset + 4));
  }
  const container = brands.some((brand) => MP4_BRANDS.has(brand))
    ? "mp4"
    : brands[0] === "qt  "
      ? "mov"
      : "unknown";

  let movieTimescale = 0;
  let movieDuration = 0;
  const tracks: TrackInfo[] = [];
  for (const box of await reader.children(moov.start, moov.end)) {
    if (box.type === "mvhd") {
      const header = parseTimeHeader(await reader.payload(box, SMALL_BOX_LIMIT));
      movieTimescale = header.timescale;
      movieDuration = header.duration;
    } else if (box.type === "trak") {
      tracks.push(await readTrack(reader, box));
    }
  }

  const video = tracks.find((track) => track.handler === "vide");
  if (video === undefined) {
    return undefined;
  }
  const rate = frameRateOf(video.timescale, video.stts);
  let durationSeconds =
    movieTimescale > 0 ? movieDuration / movieTimescale : 0;
  if (durationSeconds <= 0 && video.timescale > 0) {
    durationSeconds = video.duration / video.timescale;
  }

  return {
    container,
    videoCodec: video.codec ?? "unknown",
    width: video.width,
    height: video.height,
    frameRateNumerator: rate?.numerator ?? 0,
    frameRateDenominator: rate?.denominator ?? 0,
    audioStreamCount: tracks.filter((track) => track.handler === "soun").length,
    durationSeconds,
  };
}

/**
 * Liest die Profilmetadaten einer gespeicherten Datei. Liefert undefined,
 * wenn die Datei kein lesbares MP4 mit Videospur ist. Dateisystemfehler
 * werden weitergereicht.
 */
export async function readMp4Metadata(path: string): Promise<Mp4Metadata | undefined> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    return await parse(new BoxReader(handle, size));
  } catch (error) {
    if (error instanceof Mp4FormatError || error instanceof RangeError) {
      return undefined;
    }
    throw error;
  } finally {
    await handle.close();
  }
}
