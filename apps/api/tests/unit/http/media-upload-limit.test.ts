import { describe, expect, it } from "vitest";
import {
  MEDIA_UPLOAD_MAX_BYTES,
  MediaUploadTooLargeError,
  enforceMediaUploadLimit,
} from "../../../src/http/mediaUpload.js";
import { MEDIA_MAX_SIZE_BYTES } from "../../../src/modules/media/profile.js";

const MIB = 1024 * 1024;

/**
 * Liefert synthetische Chunks, ohne einen Gesamtpuffer der Zielgroesse
 * anzulegen: derselbe kleine Chunk wird wiederverwendet.
 */
async function* sharedChunks(
  totalBytes: number,
  chunkBytes = MIB,
): AsyncGenerator<Uint8Array> {
  const chunk = Buffer.alloc(chunkBytes, 0x5a);
  let remaining = totalBytes;
  while (remaining > 0) {
    const size = Math.min(chunkBytes, remaining);
    remaining -= size;
    yield size === chunkBytes ? chunk : chunk.subarray(0, size);
  }
}

describe("CX-157 Upload-Groessenpruefer", () => {
  it("verwendet exakt die Profilkonstante aus CX-155 als Bytezahl", () => {
    expect(MEDIA_MAX_SIZE_BYTES).toBe(1_000_000_000);
    expect(MEDIA_UPLOAD_MAX_BYTES).toBe(MEDIA_MAX_SIZE_BYTES);
  });

  it("akzeptiert genau die Profilgrenze und verwirft ein zusaetzliches Byte, ohne einen 1-GB-Puffer anzulegen", async () => {
    let acceptedBytes = 0;
    for await (const chunk of enforceMediaUploadLimit(
      sharedChunks(MEDIA_MAX_SIZE_BYTES),
    )) {
      acceptedBytes += chunk.byteLength;
    }
    expect(acceptedBytes).toBe(MEDIA_MAX_SIZE_BYTES);

    let deliveredBytes = 0;
    await expect(
      (async () => {
        for await (const chunk of enforceMediaUploadLimit(
          sharedChunks(MEDIA_MAX_SIZE_BYTES + 1),
        )) {
          deliveredBytes += chunk.byteLength;
        }
      })(),
    ).rejects.toBeInstanceOf(MediaUploadTooLargeError);

    // Das letzte, die Grenze ueberschreitende Byte wurde nicht mehr
    // weitergereicht; es entstand kein Puffer in Hoehe der Profilgrenze.
    expect(deliveredBytes).toBeLessThanOrEqual(MEDIA_MAX_SIZE_BYTES);
    expect(deliveredBytes).toBeGreaterThan(0);
  }, 30_000);
});
