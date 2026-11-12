import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeContentDigest } from "../../../src/modules/media/contentDigest.js";

// Unabhängig bekannte SHA-256-Referenzwerte (leer, "abc", "abcdef",
// "The quick brown fox jumps over the lazy dog").
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const ABCDEF_SHA256 = "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721";
const FOX_SHA256 = "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592";

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

async function* fromChunks(chunks: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe("CX-005 Inhaltsdigest: Annahme", () => {
  it("berechnet für synthetischen Byteinhalt den bekannten SHA-256-Referenzwert und die exakte Byteanzahl", async () => {
    const result = await computeContentDigest(fromChunks([bytes("abc")]));

    expect(result).toEqual({ sha256: ABC_SHA256, sizeBytes: 3 });
  });

  it("liefert für einen einzelnen Chunk und unterschiedliche Chunkschnitte identische Ergebnisse; leere Chunks ändern nichts", async () => {
    const content = "The quick brown fox jumps over the lazy dog";

    const whole = await computeContentDigest(fromChunks([bytes(content)]));
    const split = await computeContentDigest(
      fromChunks([bytes("The quick "), bytes("brown fox "), bytes("jumps over the lazy dog")]),
    );
    const withEmptyChunks = await computeContentDigest(
      fromChunks([
        new Uint8Array(0),
        bytes("The quick brown "),
        new Uint8Array(0),
        bytes("fox jumps over "),
        new Uint8Array(0),
        bytes("the lazy dog"),
        new Uint8Array(0),
      ]),
    );

    expect(whole).toEqual({ sha256: FOX_SHA256, sizeBytes: content.length });
    expect(split).toEqual(whole);
    expect(withEmptyChunks).toEqual(whole);

    // Derselbe Inhalt als Ausschnitt eines größeren Puffers (byteOffset > 0).
    const padded = new Uint8Array(content.length + 2);
    padded.set(bytes(content), 1);
    const view = padded.subarray(1, content.length + 1);
    const fromView = await computeContentDigest(fromChunks([view]));
    expect(fromView).toEqual(whole);
  });

  it("verändert bei einer Änderung eines Bytes den Hash, lässt die Byteanzahl aber unverändert", async () => {
    const original = await computeContentDigest(fromChunks([bytes("abc")]));
    const changed = await computeContentDigest(fromChunks([bytes("abd")]));

    expect(original).toEqual({ sha256: ABC_SHA256, sizeBytes: 3 });
    expect(changed.sizeBytes).toBe(3);
    expect(changed.sha256).not.toBe(original.sha256);
  });

  it("liefert für einen leeren Stream den SHA-256-Wert für leeren Inhalt und Byteanzahl null; das ist keine fachliche Medienfreigabe", async () => {
    const result = await computeContentDigest(fromChunks([]));

    expect(result).toEqual({ sha256: EMPTY_SHA256, sizeBytes: 0 });
    expect(Object.keys(result).sort()).toEqual(["sha256", "sizeBytes"]);
    expect(result).not.toHaveProperty("valid");
    expect(result).not.toHaveProperty("accepted");
  });

  it("lehnt einen Streamfehler nach bereits gelesenen Bytes ab, ohne erfolgreiches Teilergebnis", async () => {
    const streamError = new Error("synthetischer Lesefehler");
    let producedChunks = 0;

    async function* failingStream(): AsyncGenerator<Uint8Array> {
      producedChunks += 1;
      yield bytes("abc");
      producedChunks += 1;
      throw streamError;
    }

    let caught: unknown;
    let resolvedValue: unknown;
    await computeContentDigest(failingStream()).then(
      (value) => {
        resolvedValue = value;
      },
      (error: unknown) => {
        caught = error;
      },
    );

    expect(caught).toBe(streamError);
    expect(resolvedValue).toBeUndefined();
    expect(producedChunks).toBe(2);
  });

  it("liefert vor dem Ende eines verzögert abgeschlossenen Streams kein Ergebnis", async () => {
    let release: () => void = () => {
      throw new Error("Gate wurde nicht initialisiert");
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let firstChunkDelivered = false;
    let settled = false;

    async function* delayedStream(): AsyncGenerator<Uint8Array> {
      yield bytes("abc");
      firstChunkDelivered = true;
      await gate;
      yield bytes("def");
    }

    const promise = computeContentDigest(delayedStream());
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(firstChunkDelivered).toBe(true);
    expect(settled).toBe(false);

    release();
    await expect(promise).resolves.toEqual({ sha256: ABCDEF_SHA256, sizeBytes: 6 });
    expect(settled).toBe(true);
  });

  it("verarbeitet viele sequenziell erzeugte Chunks ohne Zusammenführung des Gesamtinhalts", async () => {
    const chunkCount = 4096;
    const expectedBytes = new Uint8Array(chunkCount);
    for (let index = 0; index < chunkCount; index += 1) {
      expectedBytes[index] = index % 256;
    }

    // Der Generator verwendet bewusst denselben Puffer erneut. Würde der
    // Digest die Chunks sammeln und erst am Ende hashen, sähe er nur den
    // zuletzt geschriebenen Wert; inkrementelle Verarbeitung erkennt jeden
    // Chunk vor der nächsten Mutation.
    const reusedChunk = new Uint8Array(1);
    let producedChunks = 0;

    async function* manyChunks(): AsyncGenerator<Uint8Array> {
      for (let index = 0; index < chunkCount; index += 1) {
        reusedChunk[0] = index % 256;
        producedChunks += 1;
        yield reusedChunk;
      }
    }

    const result = await computeContentDigest(manyChunks());

    expect(result.sizeBytes).toBe(chunkCount);
    expect(result.sha256).toBe(createHash("sha256").update(expectedBytes).digest("hex"));
    expect(producedChunks).toBe(chunkCount);
  });
});
