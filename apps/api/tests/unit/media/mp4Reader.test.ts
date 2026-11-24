import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  frameRateOf,
  readMp4Metadata,
  validateMediaProfile,
} from "../../../src/modules/media/index.js";

/** L-01: synthetische ISO-BMFF-Dateien, nur Kopfstrukturen plus Nutzdatenblock. */

function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
}

function u32(...values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeUInt32BE(value, index * 4));
  return buffer;
}

function ftyp(major: string, ...compatible: string[]): Buffer {
  return box(
    "ftyp",
    Buffer.from(major, "latin1"),
    u32(0),
    ...compatible.map((brand) => Buffer.from(brand, "latin1")),
  );
}

/** mvhd/mdhd Version 0: Zeitskala und Dauer. */
function timeHeader(type: "mvhd" | "mdhd", timescale: number, duration: number): Buffer {
  const body = Buffer.alloc(type === "mvhd" ? 100 : 24);
  body.writeUInt32BE(timescale, 12);
  body.writeUInt32BE(duration, 16);
  return box(type, body);
}

/** mvhd/mdhd Version 1 mit 64-Bit-Dauer. */
function timeHeaderV1(type: "mvhd" | "mdhd", timescale: number, duration: number): Buffer {
  const body = Buffer.alloc(type === "mvhd" ? 112 : 36);
  body.writeUInt8(1, 0);
  body.writeUInt32BE(timescale, 20);
  body.writeBigUInt64BE(BigInt(duration), 24);
  return box(type, body);
}

function hdlr(handler: string): Buffer {
  const body = Buffer.alloc(25);
  body.write(handler, 8, "latin1");
  return box("hdlr", body);
}

function visualEntry(type: string, width: number, height: number): Buffer {
  const body = Buffer.alloc(78);
  body.writeUInt16BE(1, 6); // data_reference_index
  body.writeUInt16BE(width, 24);
  body.writeUInt16BE(height, 26);
  return box(type, body);
}

function audioEntry(): Buffer {
  return box("mp4a", Buffer.alloc(28));
}

function stsd(entry: Buffer): Buffer {
  return box("stsd", u32(0, 1), entry);
}

function stts(entries: Array<[number, number]>): Buffer {
  return box("stts", u32(0, entries.length), ...entries.map(([count, delta]) => u32(count, delta)));
}

function track(
  handler: string,
  timescale: number,
  duration: number,
  entry: Buffer,
  timing: Array<[number, number]>,
): Buffer {
  return box(
    "trak",
    box("tkhd", Buffer.alloc(84)),
    box(
      "mdia",
      timeHeader("mdhd", timescale, duration),
      hdlr(handler),
      box("minf", box("stbl", stsd(entry), stts(timing))),
    ),
  );
}

interface SpotOptions {
  major?: string;
  compatible?: string[];
  codec?: string;
  width?: number;
  height?: number;
  timescale?: number;
  timing?: Array<[number, number]>;
  audio?: boolean;
  moovAtEnd?: boolean;
  mvhdV1?: boolean;
}

/** 15-s-Spot: 450 Frames, 30 fps (Zeitskala 15360, Delta 512). */
function spot(options: SpotOptions = {}): Buffer {
  const timescale = options.timescale ?? 15360;
  const timing = options.timing ?? [[450, 512]];
  const frames = timing.reduce((sum, [count, delta]) => sum + count * delta, 0);
  const tracks = [
    track(
      "vide",
      timescale,
      frames,
      visualEntry(options.codec ?? "avc1", options.width ?? 1920, options.height ?? 1080),
      timing,
    ),
  ];
  if (options.audio === true) {
    tracks.push(track("soun", 48000, 720000, audioEntry(), [[703, 1024]]));
  }
  const moov = box(
    "moov",
    options.mvhdV1 === true ? timeHeaderV1("mvhd", 1000, 15000) : timeHeader("mvhd", 1000, 15000),
    ...tracks,
  );
  const mdat = box("mdat", Buffer.alloc(4096, 0x5a));
  const head = ftyp(options.major ?? "isom", ...(options.compatible ?? ["isom", "iso2", "avc1", "mp41"]));
  return options.moovAtEnd === true
    ? Buffer.concat([head, mdat, moov])
    : Buffer.concat([head, moov, mdat]);
}

let directory = "";
let counter = 0;

async function fileWith(bytes: Buffer): Promise<string> {
  counter += 1;
  const path = join(directory, `spot-${counter}.mp4`);
  await writeFile(path, bytes);
  return path;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "gtads-mp4-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("L-01 MP4-Leser", () => {
  it("liest einen profilgerechten Spot (MP4, H.264, 1920x1080, 30 fps, stumm, 15 s); die Profilpruefung akzeptiert ihn", async () => {
    const bytes = spot();
    const metadata = await readMp4Metadata(await fileWith(bytes));
    expect(metadata).toEqual({
      container: "mp4",
      videoCodec: "h264",
      width: 1920,
      height: 1080,
      frameRateNumerator: 30,
      frameRateDenominator: 1,
      audioStreamCount: 0,
      durationSeconds: 15,
    });
    expect(validateMediaProfile({ ...metadata, sizeBytes: bytes.length })).toEqual({ valid: true });
  });

  it("findet moov auch hinter mdat und liest mvhd in Version 1", async () => {
    const metadata = await readMp4Metadata(await fileWith(spot({ moovAtEnd: true, mvhdV1: true })));
    expect(metadata?.durationSeconds).toBe(15);
    expect(metadata?.width).toBe(1920);
  });

  it("meldet Tonspur, falsche Aufloesung, Codec und Container so, dass die Profilpruefung die passenden Codes liefert", async () => {
    const cases: Array<{ options: SpotOptions; code: string }> = [
      { options: { audio: true }, code: "audio_not_allowed" },
      { options: { width: 1280, height: 720 }, code: "unsupported_resolution" },
      { options: { codec: "hvc1" }, code: "unsupported_video_codec" },
      { options: { major: "qt  ", compatible: ["qt  "] }, code: "unsupported_container" },
      { options: { timing: [[449, 513], [1, 400]], timescale: 15360 }, code: "unsupported_frame_rate" },
    ];
    for (const { options, code } of cases) {
      const metadata = await readMp4Metadata(await fileWith(spot(options)));
      expect(metadata, code).toBeDefined();
      const result = validateMediaProfile({ ...metadata, sizeBytes: 5000 });
      expect(result.valid, code).toBe(false);
      if (!result.valid) {
        expect(result.errors.map((error) => error.code)).toEqual([code]);
      }
    }
    const withAudio = await readMp4Metadata(await fileWith(spot({ audio: true })));
    expect(withAudio?.audioStreamCount).toBe(1);
    expect((await readMp4Metadata(await fileWith(spot({ codec: "hvc1" }))))?.videoCodec).toBe("h265");
  });

  it("liefert undefined fuer Nicht-MP4, abgeschnittene Dateien, ungueltige Boxgroessen und Dateien ohne Videospur", async () => {
    const valid = spot();
    const noVideo = Buffer.concat([
      ftyp("isom", "isom"),
      box("moov", timeHeader("mvhd", 1000, 15000), track("soun", 48000, 720000, audioEntry(), [[703, 1024]])),
    ]);
    const badSize = Buffer.from(valid);
    badSize.writeUInt32BE(0xfffffff0, ftyp("isom", "isom", "iso2", "avc1", "mp41").length);
    const inputs = [
      Buffer.from("kein Video, nur Text"),
      Buffer.alloc(0),
      valid.subarray(0, 60),
      badSize,
      noVideo,
    ];
    for (const input of inputs) {
      expect(await readMp4Metadata(await fileWith(input))).toBeUndefined();
    }
  });

  it("berechnet die Bildrate als gekuerzten Bruch und ignoriert einen abweichenden letzten Einzelframe", () => {
    expect(frameRateOf(30000, [{ count: 450, delta: 1000 }])).toEqual({ numerator: 30, denominator: 1 });
    expect(frameRateOf(30000, [{ count: 450, delta: 1001 }])).toEqual({ numerator: 30000, denominator: 1001 });
    expect(frameRateOf(15360, [{ count: 449, delta: 512 }, { count: 1, delta: 300 }])).toEqual({
      numerator: 30,
      denominator: 1,
    });
    expect(frameRateOf(0, [{ count: 1, delta: 1 }])).toBeNull();
    expect(frameRateOf(30, [])).toBeNull();
  });
});
