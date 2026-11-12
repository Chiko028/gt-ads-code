/**
 * CX-005 / GT-ADS-002: Inhaltsbasierte Berechnung von SHA-256 und Byteanzahl
 * eines Medienstreams.
 *
 * Der Baustein ergänzt CX-003, ersetzt es aber nicht: Hier wird ausschließlich
 * der tatsächlich gelesene Byteinhalt gehasht und gezählt. Es findet keine
 * Medienprofilprüfung statt (kein Dateiname, MIME-Typ, Codec, Auflösung,
 * Bildrate, Ton, Dauer, Größenlimit). Ein erfolgreiches Ergebnis ist deshalb
 * keine fachliche Medienfreigabe; ein leerer Stream ist zwar technisch
 * berechenbar, aber kein zulässiges Medium.
 *
 * Verarbeitung erfolgt inkrementell über die Chunks des Eingabestreams, ohne
 * die vollständige Datei im Speicher zusammenzuführen, ohne Dateizugriff und
 * ohne Netzwerk. Bei einem Fehler des Eingabestreams wird das Promise
 * abgelehnt; ein erfolgreiches Teilergebnis entsteht nicht.
 */

import { createHash } from "node:crypto";

/** Ergebnis der Inhaltsberechnung eines Medienstreams. */
export interface ContentDigest {
  /** SHA-256 als 64 kleingeschriebene Hexzeichen. */
  sha256: string;
  /** Summe der tatsächlich gelesenen Chunk-Bytes. */
  sizeBytes: number;
}

/**
 * Berechnet SHA-256 und Byteanzahl eines asynchronen Byte-Streams.
 *
 * Leere Chunks sind neutral. Das Ergebnis wird erst nach regulärem Ende des
 * Streams zurückgegeben; Fehler des Eingabestreams werden propagiert.
 */
export async function computeContentDigest(
  source: AsyncIterable<Uint8Array>,
): Promise<ContentDigest> {
  const hash = createHash("sha256");
  let sizeBytes = 0;

  for await (const chunk of source) {
    hash.update(chunk);
    sizeBytes += chunk.byteLength;
  }

  return { sha256: hash.digest("hex"), sizeBytes };
}
