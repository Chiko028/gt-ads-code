import { createHash } from "node:crypto";

export const REMOTE_CONTROL_ORIGIN = "admin" as const;
export type RemoteControlOrigin = typeof REMOTE_CONTROL_ORIGIN;

export interface CanonicalCommandContent {
  taxiId: string;
  desiredPaused: boolean;
  origin: RemoteControlOrigin;
}

/**
 * Kanonischer Inhalt einer Sollzustandsaenderung. expected_revision und die
 * Geraeteauswahl sind bewusst nicht enthalten: Wiederholungen derselben
 * command_id bleiben auch bei anderer erwarteter Revision idempotent.
 */
export function canonicalCommandContent(
  content: CanonicalCommandContent,
): string {
  return JSON.stringify([
    "cx-012",
    content.origin,
    content.taxiId,
    content.desiredPaused ? "pause" : "resume",
  ]);
}

export function commandContentFingerprint(
  content: CanonicalCommandContent,
): string {
  return createHash("sha256")
    .update(canonicalCommandContent(content), "utf8")
    .digest("hex");
}
