import type { FileHandle } from "node:fs/promises";
import type { PoolClient } from "pg";
import type { AuditEventInput, SqlQueryable } from "../audit/repository.js";
import { insertAuditEvent } from "../audit/repository.js";
import { computeContentDigest } from "./contentDigest.js";
import {
  MediaInputError,
  MediaInUseError,
  MediaNotFoundError,
  MediaProfileRejectedError,
  MediaStorageError,
  MediaError,
} from "./errors.js";
import { validateMediaProfile, type MediaProfileInput } from "./profile.js";
import { MediaRepository, type MediaRow } from "./repository.js";
import { LocalMediaStorage, isMediaId } from "./storage.js";
import {
  markMediaChange,
  type ManifestRefreshTrigger,
} from "../manifestRefresh/index.js";
import {
  MEDIA_AUDIT_TARGET_TYPE,
  MEDIA_CREATED_ACTION,
  MEDIA_DELETED_ACTION,
  type CreateMediaInput,
  type DeleteMediaOptions,
  type ListReadyMediaQuery,
  type MediaAuditWriter,
  type MediaDeletionResult,
  type MediaListPage,
  type MediaMetadata,
  type MediaProfileMetadata,
  type MediaRecoveryResult,
  type MediaServiceOptions,
  type ReadyMedia,
} from "./types.js";
import { randomUUID } from "node:crypto";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  return (
    typeof (value as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}

/**
 * Der Anzeigename ist ausschliesslich eine begrenzte Bezeichnung. Pfad-
 * trenner, Steuerzeichen und reine Punktfolgen werden abgelehnt, damit ein
 * manipulierter Name gar nicht erst in die Naehe einer Pfadbildung kommt.
 */
export function normalizeDisplayName(displayName: unknown): string {
  if (typeof displayName !== "string") {
    throw new MediaInputError(
      "invalid_display_name",
      "Der Anzeigename muss ein Textwert sein.",
    );
  }

  const value = displayName.trim();
  if (value.length < 1 || value.length > 255) {
    throw new MediaInputError(
      "invalid_display_name",
      "Der Anzeigename muss zwischen 1 und 255 Zeichen lang sein.",
    );
  }
  if (value === "." || value === "..") {
    throw new MediaInputError(
      "invalid_display_name",
      "Der Anzeigename darf kein reiner Pfadbestandteil sein.",
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new MediaInputError(
      "invalid_display_name",
      "Der Anzeigename darf keine Steuerzeichen enthalten.",
    );
  }
  if (value.includes("/") || value.includes("\\")) {
    throw new MediaInputError(
      "invalid_display_name",
      "Der Anzeigename darf keine Pfadtrenner enthalten.",
    );
  }

  return value;
}

function profileCandidate(
  metadata: unknown,
  sizeBytes: number,
): Record<string, unknown> {
  const record = isRecord(metadata) ? metadata : {};
  return {
    container: record.container,
    videoCodec: record.videoCodec,
    width: record.width,
    height: record.height,
    frameRateNumerator: record.frameRateNumerator,
    frameRateDenominator: record.frameRateDenominator,
    audioStreamCount: record.audioStreamCount,
    durationSeconds: record.durationSeconds,
    sizeBytes,
  };
}

function toProfile(validated: Record<string, unknown>): MediaProfileMetadata {
  const profile = validated as unknown as MediaProfileInput;
  return {
    container: profile.container,
    videoCodec: profile.videoCodec,
    width: profile.width,
    height: profile.height,
    frameRateNumerator: profile.frameRateNumerator,
    frameRateDenominator: profile.frameRateDenominator,
    audioStreamCount: profile.audioStreamCount,
    durationSeconds: profile.durationSeconds,
  };
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
    );
    if (result.bytesWritten <= 0) {
      throw new MediaStorageError(
        "write_failed",
        "Die temporaere Datei konnte nicht vollstaendig geschrieben werden.",
      );
    }
    offset += result.bytesWritten;
  }
}

function mediaCreatedEvent(input: {
  at: Date;
  id: string;
  sizeBytes: number;
  sha256: string;
  actorType?: "admin" | "device" | "system";
  actorId?: string | null;
  recovered?: boolean;
}): AuditEventInput {
  const details: Record<string, unknown> = {
    size_bytes: input.sizeBytes,
    sha256: input.sha256,
  };
  if (input.recovered === true) {
    details.recovered = true;
  }

  return {
    at: input.at,
    actorType: input.actorType ?? "system",
    actorId: input.actorId ?? null,
    action: MEDIA_CREATED_ACTION,
    targetType: MEDIA_AUDIT_TARGET_TYPE,
    targetId: input.id,
    details,
  };
}

function mediaDeletedEvent(input: {
  at: Date;
  id: string;
  actorType?: "admin" | "device" | "system";
  actorId?: string | null;
}): AuditEventInput {
  return {
    at: input.at,
    actorType: input.actorType ?? "system",
    actorId: input.actorId ?? null,
    action: MEDIA_DELETED_ACTION,
    targetType: MEDIA_AUDIT_TARGET_TYPE,
    targetId: input.id,
    details: {},
  };
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * R-201 / CX-030: lokaler Medienspeicher.
 *
 * Bytes werden zuerst in eine temporaere Datei geschrieben; CX-005 liefert
 * SHA-256 und Groesse, CX-003 prueft das Profil. Erst nach vorhandener und
 * gepruefter finaler Datei werden ready und das Audit in EINER Transaktion
 * gesetzt. Staging bleibt bis dahin unsichtbar.
 */
export class MediaService {
  private readonly pool: MediaServiceOptions["pool"];
  private readonly storage: LocalMediaStorage;
  private readonly repository: MediaRepository;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly auditWriter: MediaAuditWriter | undefined;
  private readonly manifestRefresh: ManifestRefreshTrigger | undefined;

  constructor(options: MediaServiceOptions) {
    this.pool = options.pool;
    this.storage = new LocalMediaStorage(options.storageRoot);
    this.repository = new MediaRepository(options.pool);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.auditWriter = options.auditWriter;
    this.manifestRefresh = options.manifestRefresh;
  }

  private scheduleRefresh(): void {
    if (this.manifestRefresh === undefined) {
      return;
    }
    void this.manifestRefresh
      .drainPending({ limit: 10 })
      .catch(() => undefined);
  }

  async createMedia(input: CreateMediaInput): Promise<ReadyMedia> {
    const displayName = normalizeDisplayName(input.displayName);
    if (!isAsyncIterable(input.content)) {
      throw new MediaInputError(
        "invalid_content",
        "Die Uploadbytes muessen als asynchroner Byte-Strom vorliegen.",
      );
    }

    const id = this.idFactory();
    if (!isMediaId(id)) {
      throw new MediaStorageError(
        "invalid_media_id",
        "Der erzeugte Medien-Schluessel ist keine gueltige UUID.",
      );
    }

    const createdAt = this.now();
    await this.storage.ensureLayout();
    await this.repository.insertStaging(id, displayName, createdAt);

    let handle: FileHandle | null = null;
    let published = false;
    let digestSha = "";
    let digestSize = 0;
    let profile: MediaProfileMetadata;

    try {
      handle = await this.storage.createTemp(id);
      const digest = await computeContentDigest(
        this.writeThrough(input.content, handle),
      );
      digestSha = digest.sha256;
      digestSize = digest.sizeBytes;

      await handle.sync();
      await handle.close();
      handle = null;

      const candidate = profileCandidate(input.metadata, digestSize);
      const validation = validateMediaProfile(candidate);
      if (!validation.valid) {
        throw new MediaProfileRejectedError(validation.errors);
      }
      profile = toProfile(candidate);

      const attached = await this.repository.attachStagingMetadata(
        id,
        digestSize,
        digestSha,
        profile,
      );
      if (!attached) {
        throw new MediaStorageError(
          "staging_missing",
          "Der staging-Eintrag fehlt oder ist nicht mehr offen.",
        );
      }

      await this.storage.publish(id);
      published = true;
      await this.storage.verifyFinal(id, digestSize, digestSha);
    } catch (error) {
      if (handle !== null) {
        await handle.close().catch(() => undefined);
      }
      await this.cleanupFailedCreate(id, published);
      throw this.asMediaError(error);
    }

    // Ab hier bleibt ein gueltiger staging-Eintrag samt finaler Datei fuer den
    // expliziten Wiederanlauf stehen, falls Transaktion oder Audit scheitern.
    const metadata = await this.withTransaction(async (client) => {
      const readyAt = this.now();
      const updated = await this.repository.markReady(client, id, readyAt);
      if (updated !== null) {
        await markMediaChange(client, id, readyAt);
        await this.writeAudit(
          client,
          mediaCreatedEvent({
            at: readyAt,
            id,
            sizeBytes: digestSize,
            sha256: digestSha,
            actorType: input.actorType,
            actorId: input.actorId,
          }),
        );
        return updated;
      }

      // Ein paralleler Wiederanlauf kann den Eintrag bereits bereitgestellt
      // haben; dann ist kein zweites Audit noetig.
      const existing = await this.repository.findReadyWith(client, id);
      if (existing !== null) {
        return existing;
      }

      throw new MediaStorageError(
        "ready_conflict",
        "Der staging-Eintrag konnte nicht bereitgestellt werden.",
      );
    });

    this.scheduleRefresh();
    return this.toReadyMedia(metadata);
  }

  /**
   * R-203 / CX-078: logische Loeschung ohne Datei- oder Byteveraenderung.
   *
   * Die Zeile wird mit FOR UPDATE gesperrt; Zuordnung und Aktivierung halten
   * dieselbe Zeile mit FOR SHARE. Markierung und media.deleted-Audit laufen in
   * genau einer Transaktion. Aktive, nicht archivierte Kampagnen und
   * aktuell veroeffentlichte Manifest-Referenzen sperren die Loeschung. Ein
   * bereits markiertes Medium liefert dasselbe Ergebnis ohne zweites Audit;
   * unbekannte
   * oder nicht bereite Medien gelten als nicht gefunden. Die Bytes bleiben
   * lesbar, Listen blenden sie aus.
   */
  async deleteMedia(
    id: string,
    options: DeleteMediaOptions = {},
  ): Promise<MediaDeletionResult> {
    if (!isMediaId(id)) {
      throw new MediaInputError(
        "invalid_media_id",
        "Der Medien-Schluessel ist keine gueltige UUID.",
      );
    }

    return this.withTransaction(async (client) => {
      const row = await this.repository.lockForDeletion(client, id);
      if (row === null || row.status !== "ready") {
        throw new MediaNotFoundError(id);
      }
      if (row.deleted_at !== null) {
        return {
          id: row.id,
          deletedAt: asDate(row.deleted_at),
          alreadyDeleted: true,
        };
      }
      if (await this.repository.hasActiveCampaign(client, id)) {
        throw new MediaInUseError(id);
      }
      // CX-045: Der GT-Ads-Fallback erzeugt keine Kampagne, ist aber im
      // aktuell veroeffentlichten Manifest referenziert. Diese Referenz
      // schuetzt das Platzhaltermedium genauso vor der Loeschung.
      if (await this.repository.hasManifestReference(client, id)) {
        throw new MediaInUseError(id);
      }

      const at = this.now();
      const deletedAt = await this.repository.markDeleted(client, id, at);
      if (deletedAt === null) {
        // Unter der exklusiven Zeilensperre darf das nur eintreten, wenn ein
        // anderer Weg die Zeile gleichzeitig veraendert hat.
        throw new MediaStorageError(
          "delete_conflict",
          "Die Loeschmarkierung konnte nicht gesetzt werden.",
        );
      }
      await this.writeAudit(
        client,
        mediaDeletedEvent({
          at,
          id,
          actorType: options.actorType,
          actorId: options.actorId,
        }),
      );
      return { id, deletedAt, alreadyDeleted: false };
    });
  }

  async getReadyMedia(id: string): Promise<ReadyMedia | null> {
    if (!isMediaId(id)) {
      throw new MediaInputError(
        "invalid_media_id",
        "Der Medien-Schluessel ist keine gueltige UUID.",
      );
    }

    await this.storage.ensureLayout();
    const metadata = await this.repository.findReady(id);
    if (metadata === null) {
      return null;
    }
    if (
      !(await this.storage.finalMatches(
        metadata.id,
        metadata.sizeBytes,
        metadata.sha256,
      ))
    ) {
      return null;
    }
    return this.toReadyMedia(metadata);
  }

  async listReadyMedia(query: ListReadyMediaQuery = {}): Promise<MediaListPage> {
    await this.storage.ensureLayout();
    return this.repository.listReady(query);
  }

  /**
   * Expliziter, idempotenter Wiederanlauf fuer liegengebliebene
   * staging-Eintraege. Es werden ausschliesslich Dateien angefasst, deren
   * Pfad aus der eigenen staging-ID abgeleitet ist. Nicht passende Dateien
   * (insbesondere fremde Objekte) bleiben unveraendert.
   */
  async recoverStaging(): Promise<MediaRecoveryResult> {
    await this.storage.ensureLayout();
    const rows = await this.repository.listStaging();

    let completed = 0;
    let cleaned = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const outcome = await this.recoverRow(row);
        if (outcome === "completed") {
          completed += 1;
        } else if (outcome === "cleaned") {
          cleaned += 1;
        }
      } catch {
        failed += 1;
      }
    }

    return { completed, cleaned, failed };
  }

  private async recoverRow(
    row: MediaRow,
  ): Promise<"completed" | "cleaned" | "unchanged"> {
    const completeMetadata =
      row.size_bytes !== null &&
      row.sha256 !== null &&
      row.container !== null &&
      row.video_codec !== null &&
      row.width !== null &&
      row.height !== null &&
      row.frame_rate_numerator !== null &&
      row.frame_rate_denominator !== null &&
      row.audio_stream_count !== null &&
      row.duration_seconds !== null;

    if (!completeMetadata) {
      // Vor der Metadatenuebernahme abgebrochen: nur die eigene Temp-Datei und
      // die eigene staging-Zeile entfernen; finale Dateien bleiben unberuehrt.
      await this.storage.removeTemp(row.id);
      const deleted = await this.repository.deleteStaging(row.id);
      return deleted ? "cleaned" : "unchanged";
    }

    const sizeBytes = Number(row.size_bytes);
    const sha256 = row.sha256 as string;

    if (await this.storage.finalMatches(row.id, sizeBytes, sha256)) {
      const done = await this.completeRecovery(row.id, sizeBytes, sha256);
      if (done) {
        await this.storage.removeTemp(row.id);
        return "completed";
      }
      return "unchanged";
    }

    if (await this.storage.tempMatches(row.id, sizeBytes, sha256)) {
      try {
        await this.storage.publish(row.id);
      } catch (error) {
        const isExisting =
          error instanceof MediaStorageError && error.code === "object_exists";
        if (!isExisting) {
          throw error;
        }
        // Ein fremdes Zielobjekt wird nicht ueberschrieben und nicht geloescht.
      }

      if (await this.storage.finalMatches(row.id, sizeBytes, sha256)) {
        const done = await this.completeRecovery(row.id, sizeBytes, sha256);
        if (done) {
          await this.storage.removeTemp(row.id);
          return "completed";
        }
        return "unchanged";
      }

      // Eigene Temp-Datei entfernen, fremdes Zielobjekt unangetastet lassen.
      await this.storage.removeTemp(row.id);
      const deleted = await this.repository.deleteStaging(row.id);
      return deleted ? "cleaned" : "unchanged";
    }

    // Keine passende Datei: staging-Zeile bereinigen, unbekannte Dateien
    // werden nicht geloescht.
    const deleted = await this.repository.deleteStaging(row.id);
    return deleted ? "cleaned" : "unchanged";
  }

  private async completeRecovery(
    id: string,
    sizeBytes: number,
    sha256: string,
  ): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const readyAt = this.now();
      const updated = await this.repository.markReady(client, id, readyAt);
      if (updated === null) {
        return false;
      }
      await this.writeAudit(
        client,
        mediaCreatedEvent({
          at: readyAt,
          id,
          sizeBytes,
          sha256,
          recovered: true,
        }),
      );
      return true;
    });
  }

  private async *writeThrough(
    source: AsyncIterable<Uint8Array>,
    handle: FileHandle,
  ): AsyncGenerator<Uint8Array> {
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array)) {
        throw new MediaInputError(
          "invalid_content",
          "Der Byte-Strom lieferte keinen Uint8Array-Chunk.",
        );
      }
      if (chunk.byteLength > 0) {
        await writeAll(handle, chunk);
      }
      yield chunk;
    }
  }

  private async cleanupFailedCreate(
    id: string,
    published: boolean,
  ): Promise<void> {
    await this.storage.removeTemp(id).catch(() => undefined);
    if (published) {
      await this.storage.removeFinal(id).catch(() => undefined);
    }
    await this.repository.deleteStaging(id).catch(() => undefined);
  }

  private async withTransaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // Der urspruengliche Fehler bleibt massgeblich.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async writeAudit(
    executor: SqlQueryable,
    event: AuditEventInput,
  ): Promise<void> {
    if (this.auditWriter !== undefined) {
      await this.auditWriter(executor, event);
      return;
    }
    // Vorhandener U3-Schreibweg; laeuft auf dem Transaktionsclient.
    await insertAuditEvent(executor, event);
  }

  private toReadyMedia(metadata: MediaMetadata): ReadyMedia {
    return {
      ...metadata,
      read: () => this.storage.readFinal(metadata.id, metadata.sizeBytes),
    };
  }

  private asMediaError(error: unknown): MediaError {
    if (error instanceof MediaError) {
      return error;
    }
    const message =
      error instanceof Error ? error.message : "Unbekannter Speicherfehler";
    return new MediaStorageError("storage_failure", message, { cause: error });
  }
}

export function createMediaService(options: MediaServiceOptions): MediaService {
  return new MediaService(options);
}

/** Funktions-Export laut CX-030; erzeugt einen Service mit denselben Optionen. */
export function createMedia(
  options: MediaServiceOptions,
  input: CreateMediaInput,
): Promise<ReadyMedia> {
  return new MediaService(options).createMedia(input);
}

export function deleteMedia(
  options: MediaServiceOptions,
  id: string,
  deleteOptions: DeleteMediaOptions = {},
): Promise<MediaDeletionResult> {
  return new MediaService(options).deleteMedia(id, deleteOptions);
}

export function getReadyMedia(
  options: MediaServiceOptions,
  id: string,
): Promise<ReadyMedia | null> {
  return new MediaService(options).getReadyMedia(id);
}

export function listReadyMedia(
  options: MediaServiceOptions,
  query: ListReadyMediaQuery = {},
): Promise<MediaListPage> {
  return new MediaService(options).listReadyMedia(query);
}

export function recoverStagingMedia(
  options: MediaServiceOptions,
): Promise<MediaRecoveryResult> {
  return new MediaService(options).recoverStaging();
}
