/**
 * CX-041 / R-301: begrenzter, explizit aufrufbarer Manifest-Neuberechnungslauf.
 *
 * Der Dienst orchestriert ausschliesslich vorhandene Bausteine:
 *   - CX-024/CX-025 pruefen Belegungen und bauen den Schleifenplan,
 *   - CX-007 signiert und verifiziert das unveraenderliche Artefakt.
 *
 * Es gibt keinen Timer, keinen HTTP-Endpunkt und keine Infrastruktur. Jeder
 * Aufruf verarbeitet hoechstens die explizit gesetzte Anzahl offener Taxis.
 * Fachzustand, Revision, Artefakt und Veroeffentlichung liegen je Taxi in
 * genau einer Transaktion; die Zeilensperre serialisiert Laeufe je Taxi.
 */
import type { Pool } from "pg";
import { validateMediaProfile } from "../media/profile.js";
import type { SqlQueryable } from "../audit/repository.js";
import {
  createSignedManifest,
  verifySignedManifest,
  type ManifestEnvironment,
  type SignedManifestEnvelope,
} from "../playout/manifest.js";
import {
  buildLoopPlan,
  type LoopPlan as BuiltLoopPlan,
} from "../playout/planner.js";
import type { LoopPlan } from "../playout/types.js";
import { markTaxiRevisions } from "./marking.js";
import { loadTaxiManifestSource, type TaxiManifestSource } from "./source.js";
import type {
  DrainResult,
  ManifestArtifactRecord,
  ManifestRefreshItemResult,
  ManifestRefreshOptions,
  ManifestRefreshState,
} from "./types.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const MIN_SLOT_COUNT = 12;
const MAX_SLOT_COUNT = 16;
const MAX_ERROR_LENGTH = 500;

/**
 * Stabiler Platzhalter-Kampagnenschluessel des GT-Ads-Fallbacks. Es entsteht
 * keine Kundenkampagne und keine Buchung; der Wert markiert ausschliesslich
 * die bestehenden Manifestfelder dieses Ersatzes.
 */
export const FALLBACK_CAMPAIGN_ID = "gt-ads-fallback";

/**
 * Technisches, zeitunabhaengiges Laufzeitfenster des Platzhalters. Dadurch
 * bleibt eine identische Erzeugung unabhaengig vom Auswertungszeitpunkt
 * bytegleich; es entsteht keine Kundenkampagne und keine Buchung.
 */
const FALLBACK_START_AT = "1970-01-01T00:00:00.000Z";
const FALLBACK_END_AT = "9999-12-31T23:59:59.999Z";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ManifestFallbackErrorCode =
  | "fallback_config_missing"
  | "fallback_config_invalid"
  | "fallback_media_not_found"
  | "fallback_media_unavailable"
  | "fallback_media_invalid";

/** Nachvollziehbarer Fehler des R-305-Platzhalterpfads. */
export class ManifestFallbackError extends Error {
  readonly code: ManifestFallbackErrorCode;

  constructor(code: ManifestFallbackErrorCode, message: string) {
    super(code + ": " + message);
    this.name = "ManifestFallbackError";
    this.code = code;
  }
}

interface StateRow {
  requested_revision: string;
  processed_revision: string;
}

interface FallbackMediaRow {
  id: string;
  sha256: string | null;
  size_bytes: string | number | null;
  container: string | null;
  video_codec: string | null;
  width: number | null;
  height: number | null;
  frame_rate_numerator: number | null;
  frame_rate_denominator: number | null;
  audio_stream_count: number | null;
  duration_seconds: number | string | null;
  status: string;
  deleted_at: Date | null;
}

interface ArtifactRow {
  taxi_id: string;
  version: string;
  key_id: string;
  environment: ManifestEnvironment;
  payload_base64: string;
  signature_base64: string;
  source_revision: string;
  created_at: Date;
}

interface RefreshStateRow {
  taxi_id: string;
  requested_revision: string;
  processed_revision: string;
  current_version: string | null;
  current_revision: string | null;
  last_error: string | null;
  updated_at: Date;
}

function checkedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new Error(
      "limit muss eine ganze Zahl zwischen 1 und " + MAX_LIMIT + " sein.",
    );
  }
  return value;
}

function checkedSlotCount(value: number | undefined): number {
  if (value === undefined) {
    return MIN_SLOT_COUNT;
  }
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_SLOT_COUNT ||
    value > MAX_SLOT_COUNT
  ) {
    throw new Error(
      "slotCount muss eine ganze Zahl zwischen " +
        MIN_SLOT_COUNT +
        " und " +
        MAX_SLOT_COUNT +
        " sein.",
    );
  }
  return value;
}

function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code: unknown }).code;
  return code === "40001" || code === "40P01";
}

function cleanError(error: unknown): string {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name: unknown }).name)
      : "Error";
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unbekannter Fehler";
  const text = (name + ": " + message).replace(/\s+/g, " ").trim();
  return text.length > MAX_ERROR_LENGTH
    ? text.slice(0, MAX_ERROR_LENGTH)
    : text;
}

function toSafeRevision(value: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Ungueltige persistierte Revision.");
  }
  return revision;
}

/**
 * Baut aus den aktiven Kampagnen eine explizite fixed_slot-Belegung. Die
 * vorhandenen Kampagnen werden in stabiler ID-Reihenfolge zyklisch auf die
 * konfigurierten Plaetze verteilt. Laufzeitfenster und Medienmetadaten werden
 * unveraendert uebernommen; es entsteht kein neuer Belegungsstandard.
 */
function buildBookings(source: TaxiManifestSource, slotCount: number): unknown[] {
  const campaigns = source.campaigns;
  if (campaigns.length === 0) {
    throw new Error(
      "empty_bookings: Fuer dieses Taxi liegt keine ausspielbare Belegung vor.",
    );
  }

  const bookings: unknown[] = [];
  for (let position = 1; position <= slotCount; position += 1) {
    const campaign = campaigns[(position - 1) % campaigns.length];
    if (campaign === undefined) {
      throw new Error("empty_bookings: Belegung konnte nicht aufgebaut werden.");
    }
    bookings.push({
      position,
      campaign: {
        id: campaign.id,
        status: "active" as const,
        startAt: campaign.startAt,
        endAt: campaign.endAt,
        taxiIds: [...campaign.taxiIds],
        groupIds: [...campaign.groupIds],
      },
      media: {
        id: campaign.mediaId,
        sha256: campaign.sha256,
        sizeBytes: campaign.sizeBytes,
        durationMs: campaign.durationMs,
      },
    });
  }
  return bookings;
}

/**
 * Liest das konfigurierte Platzhaltermedium ausschliesslich aus der bereits
 * ueber CX-030/031 gespeicherten Medienzeile und prueft es erneut gegen das
 * CX-003-Profil. Es wird nichts hochgeladen, geladen oder transkodiert.
 */
async function loadFallbackMedia(
  executor: SqlQueryable,
  fallbackMediaId: string | null,
): Promise<{
  id: string;
  sha256: string;
  sizeBytes: number;
  durationMs: number;
}> {
  if (fallbackMediaId === null) {
    throw new ManifestFallbackError(
      "fallback_config_missing",
      "Es ist kein GT-Ads-Platzhaltermedium konfiguriert (fallbackMediaId).",
    );
  }
  if (!UUID_PATTERN.test(fallbackMediaId)) {
    throw new ManifestFallbackError(
      "fallback_config_invalid",
      "Die konfigurierte fallbackMediaId ist keine gueltige Medien-UUID.",
    );
  }

  const result = await executor.query<FallbackMediaRow>(
    [
      "select id::text as id, sha256, size_bytes, container, video_codec,",
      "       width, height, frame_rate_numerator, frame_rate_denominator,",
      "       audio_stream_count, duration_seconds, status, deleted_at",
      "  from media_objects",
      " where id = $1::uuid",
    ].join("\n"),
    [fallbackMediaId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ManifestFallbackError(
      "fallback_media_not_found",
      "Das konfigurierte GT-Ads-Platzhaltermedium wurde nicht gespeichert.",
    );
  }
  if (row.status !== "ready" || row.deleted_at !== null) {
    throw new ManifestFallbackError(
      "fallback_media_unavailable",
      "Das konfigurierte GT-Ads-Platzhaltermedium ist nicht bereit oder geloescht.",
    );
  }

  const sizeBytes = Number(row.size_bytes);
  const durationSeconds = Number(row.duration_seconds);
  const profile = validateMediaProfile({
    container: row.container,
    videoCodec: row.video_codec,
    width: row.width,
    height: row.height,
    frameRateNumerator: row.frame_rate_numerator,
    frameRateDenominator: row.frame_rate_denominator,
    audioStreamCount: row.audio_stream_count,
    durationSeconds,
    sizeBytes,
  });
  if (!profile.valid) {
    throw new ManifestFallbackError(
      "fallback_media_invalid",
      "Das GT-Ads-Platzhaltermedium verletzt das Medienprofil (" +
        profile.errors.map((error) => error.code).join(", ") +
        ").",
    );
  }
  if (
    row.sha256 === null ||
    !/^[0-9a-f]{64}$/.test(row.sha256) ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    throw new ManifestFallbackError(
      "fallback_media_invalid",
      "Das GT-Ads-Platzhaltermedium hat unvollstaendige Metadaten.",
    );
  }

  return {
    id: row.id,
    sha256: row.sha256,
    sizeBytes,
    durationMs: Math.round(durationSeconds * 1000),
  };
}

/**
 * Bildet die konfigurierte Schleifenkapazitaet ausschliesslich mit
 * Wiederholungen des vorhandenen Platzhaltermediums ab. Es werden keine
 * Kundenkampagne und keine Buchung erfunden; Zeitfenster und Positionen sind
 * deterministisch aus dem festen Platzhalterfenster abgeleitet.
 */
function buildFallbackBookings(
  taxiId: string,
  media: {
    id: string;
    sha256: string;
    sizeBytes: number;
    durationMs: number;
  },
  slotCount: number,
): unknown[] {
  const startAt = FALLBACK_START_AT;
  const endAt = FALLBACK_END_AT;
  const bookings: unknown[] = [];
  for (let position = 1; position <= slotCount; position += 1) {
    bookings.push({
      position,
      campaign: {
        id: FALLBACK_CAMPAIGN_ID,
        status: "active" as const,
        startAt,
        endAt,
        taxiIds: [taxiId],
        groupIds: [],
      },
      media: {
        id: media.id,
        sha256: media.sha256,
        sizeBytes: media.sizeBytes,
        durationMs: media.durationMs,
      },
    });
  }
  return bookings;
}

/** Uebernimmt das CX-025-Ergebnis verlustfrei in die CX-007-Planform. */
function toManifestPlan(built: BuiltLoopPlan): LoopPlan {
  return {
    taxiId: built.taxiId,
    slotCount: built.slotCount,
    loopDurationMs: built.totalDurationMs,
    spots: built.entries.map((entry) => ({
      position: entry.position,
      campaignId: entry.campaignId,
      mediaId: entry.mediaId,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
      durationMs: entry.durationMs,
      startAt: entry.startAt,
      endAt: entry.endAt,
    })),
  };
}

function toArtifact(row: ArtifactRow): ManifestArtifactRecord {
  const envelope: SignedManifestEnvelope = {
    schemaVersion: 1,
    keyId: row.key_id,
    version: row.version,
    payloadBase64: row.payload_base64,
    signatureBase64: row.signature_base64,
  };
  return {
    taxiId: row.taxi_id,
    version: row.version,
    keyId: row.key_id,
    environment: row.environment,
    payloadBase64: row.payload_base64,
    signatureBase64: row.signature_base64,
    sourceRevision: toSafeRevision(row.source_revision),
    createdAt: new Date(row.created_at),
    envelope,
  };
}

export class ManifestRefreshService {
  private readonly pool: Pool;
  private readonly options: ManifestRefreshOptions;
  private readonly now: () => Date;
  private readonly slotCount: number;
  private readonly fallbackMediaId: string | null;
  private readonly defaultLimit: number;

  constructor(options: ManifestRefreshOptions) {
    this.pool = options.pool;
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.slotCount = checkedSlotCount(options.slotCount);
    this.fallbackMediaId =
      options.fallbackMediaId === undefined ||
      options.fallbackMediaId === null ||
      options.fallbackMediaId.trim() === ""
        ? null
        : options.fallbackMediaId.trim().toLowerCase();
    this.defaultLimit = checkedLimit(options.defaultLimit, DEFAULT_LIMIT);
  }

  /**
   * Verarbeitet begrenzt offene Taxis. Die Auswahl ist deterministisch; jeder
   * Kandidat wird in einer eigenen Transaktion gesperrt. Konkurrierende Laeufe
   * koennen daher dieselbe Zeile nicht gleichzeitig verarbeiten.
   */
  async drainPending(
    options: { limit?: number } = {},
  ): Promise<DrainResult> {
    const limit = checkedLimit(options.limit, this.defaultLimit);
    const pending = await this.pool.query<{ taxi_id: string }>(
      [
        "select taxi_id",
        "  from taxi_manifest_state",
        " where requested_revision > processed_revision",
        " order by taxi_id asc",
        " limit $1",
      ].join("\n"),
      [limit],
    );

    const items: ManifestRefreshItemResult[] = [];
    for (const row of pending.rows) {
      items.push(await this.processTaxi(row.taxi_id));
    }

    return {
      scanned: items.length,
      published: items.filter((item) => item.status === "published").length,
      skipped: items.filter((item) => item.status === "skipped").length,
      failed: items.filter((item) => item.status === "failed").length,
      items,
    };
  }

  private async processTaxi(taxiId: string): Promise<ManifestRefreshItemResult> {
    const client = await this.pool.connect();
    let requested = 0;
    let processed = 0;

    try {
      await client.query("begin isolation level repeatable read");

      // Die Zeilensperre ist der Serialisierungspunkt je Taxi. Eine parallele
      // Markierung kann erst nach dem Commit eine neue Revision anfordern.
      const stateResult = await client.query<StateRow>(
        [
          "select requested_revision, processed_revision",
          "  from taxi_manifest_state",
          " where taxi_id = $1",
          "   for update",
        ].join("\n"),
        [taxiId],
      );
      const state = stateResult.rows[0];
      if (state === undefined) {
        await client.query("commit");
        return {
          taxiId,
          status: "skipped",
          requestedRevision: 0,
          processedRevision: 0,
        };
      }

      requested = toSafeRevision(state.requested_revision);
      processed = toSafeRevision(state.processed_revision);

      if (requested <= processed) {
        await client.query("commit");
        return {
          taxiId,
          status: "skipped",
          requestedRevision: requested,
          processedRevision: processed,
        };
      }

      const evaluatedAt = this.now();
      const source = await loadTaxiManifestSource(client, taxiId, evaluatedAt);
      const bookings =
        source.campaigns.length > 0
          ? buildBookings(source, this.slotCount)
          : buildFallbackBookings(
              taxiId,
              await loadFallbackMedia(client, this.fallbackMediaId),
              this.slotCount,
            );
      const built = (this.options.planner ?? buildLoopPlan)({
        taxiId,
        groupIds: source.groupIds,
        slotCount: this.slotCount,
        bookings,
      });
      const plan = toManifestPlan(built);
      const signer = this.options.signer ?? createSignedManifest;
      const envelope = signer({
        plan,
        environment: this.options.environment,
        keyId: this.options.keyId,
        signingKey: this.options.signingKey,
      });

      // CX-007 prueft die eigene Ausgabe, bevor irgendetwas veroeffentlicht
      // wird. Ein Signier- oder Prueffehler laesst die Arbeit offen.
      const verifier = this.options.verifier ?? verifySignedManifest;
      verifier(envelope, {
        taxiId,
        environment: this.options.environment,
        trustedKeys: this.options.trustedKeys,
      });

      const createdAt = evaluatedAt;
      await client.query(
        [
          "insert into taxi_manifest_artifacts",
          "  (taxi_id, version, key_id, environment, payload_base64,",
          "   signature_base64, source_revision, created_at)",
          "values ($1, $2, $3, $4, $5, $6, $7, $8)",
          "on conflict (taxi_id, version) do nothing",
        ].join("\n"),
        [
          taxiId,
          envelope.version,
          envelope.keyId,
          this.options.environment,
          envelope.payloadBase64,
          envelope.signatureBase64,
          requested,
          createdAt,
        ],
      );

      const updated = await client.query(
        [
          "update taxi_manifest_state",
          "   set processed_revision = $2,",
          "       current_version = $3,",
          "       current_revision = $2,",
          "       last_error = null,",
          "       updated_at = $4",
          " where taxi_id = $1",
          "   and requested_revision >= $2",
          " returning processed_revision",
        ].join("\n"),
        [taxiId, requested, envelope.version, createdAt],
      );

      if ((updated.rowCount ?? 0) !== 1) {
        throw new Error(
          "state_conflict: Die angeforderte Revision wurde waehrend der Verarbeitung veraendert.",
        );
      }

      await client.query("commit");
      return {
        taxiId,
        status: "published",
        requestedRevision: requested,
        processedRevision: requested,
        version: envelope.version,
      };
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // Der urspruengliche Fehler bleibt massgeblich.
      }

      if (isRetryableTransactionError(error)) {
        // Ein konkurrierender Lauf hat den Datensatz bereits verarbeitet. Die
        // offene Revision bleibt fuer den naechsten Aufruf erhalten.
        return {
          taxiId,
          status: "skipped",
          requestedRevision: requested,
          processedRevision: processed,
        };
      }

      const cleaned = cleanError(error);
      await this.pool
        .query(
          [
            "update taxi_manifest_state",
            "   set last_error = $2, updated_at = $3",
            " where taxi_id = $1",
          ].join("\n"),
          [taxiId, cleaned, this.now()],
        )
        .catch(() => undefined);

      return {
        taxiId,
        status: "failed",
        requestedRevision: requested,
        processedRevision: processed,
        error: cleaned,
      };
    } finally {
      client.release();
    }
  }

  async getRefreshState(taxiId: string): Promise<ManifestRefreshState | null> {
    const result = await this.pool.query<RefreshStateRow>(
      [
        "select taxi_id, requested_revision, processed_revision,",
        "       current_version, current_revision, last_error, updated_at",
        "  from taxi_manifest_state",
        " where taxi_id = $1",
      ].join("\n"),
      [taxiId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      taxiId: row.taxi_id,
      requestedRevision: toSafeRevision(row.requested_revision),
      processedRevision: toSafeRevision(row.processed_revision),
      currentVersion: row.current_version,
      currentRevision:
        row.current_revision === null
          ? null
          : toSafeRevision(row.current_revision),
      lastError: row.last_error,
      updatedAt: new Date(row.updated_at),
    };
  }

  async listArtifacts(taxiId: string): Promise<ManifestArtifactRecord[]> {
    const result = await this.pool.query<ArtifactRow>(
      [
        "select taxi_id, version, key_id, environment, payload_base64,",
        "       signature_base64, source_revision, created_at",
        "  from taxi_manifest_artifacts",
        " where taxi_id = $1",
        " order by created_at asc, version asc",
      ].join("\n"),
      [taxiId],
    );
    return result.rows.map(toArtifact);
  }

  async getCurrentArtifact(
    taxiId: string,
  ): Promise<ManifestArtifactRecord | null> {
    const result = await this.pool.query<ArtifactRow>(
      [
        "select a.taxi_id, a.version, a.key_id, a.environment,",
        "       a.payload_base64, a.signature_base64,",
        "       a.source_revision, a.created_at",
        "  from taxi_manifest_state s",
        "  join taxi_manifest_artifacts a",
        "    on a.taxi_id = s.taxi_id and a.version = s.current_version",
        " where s.taxi_id = $1",
      ].join("\n"),
      [taxiId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toArtifact(row);
  }
}

/** Markiert ein einzelnes Taxi; nur fuer den kontrollierten Zuordnungsdienst. */
export async function markTaxiForRefresh(
  executor: SqlQueryable,
  taxiId: string,
  at: Date,
): Promise<void> {
  await markTaxiRevisions(executor, [taxiId], at);
}

