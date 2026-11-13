import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  insertAuditEvent,
  type AuditEventInput,
  type SqlQueryable,
} from "../audit/repository.js";

/**
 * Einmalige MFA-Wiederherstellungscodes (R-605) als Nachfolger des
 * TOTP-Pruefkerns aus CX-017. Der Kern erzeugt, ersetzt und verbraucht
 * kontogebundene Codes. Klartext verlaesst dieses Modul ausschliesslich beim
 * Erzeugen eines Codesatzes; gespeichert werden nur SHA-256-Hashes.
 *
 * Es gibt bewusst keine HTTP-Route, keinen Scheduler und keinen Bezug zu
 * Passwort- oder TOTP-Reset.
 */

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_RANDOM_BYTES = 16;
export const RECOVERY_CODE_HEX_LENGTH = 32;
export const RECOVERY_CODE_HASH_DOMAIN =
  "gt-ads:admin-mfa-recovery-code:v1";

/** Stabile Audit-Aktionsnamen; sie werden in Tests geprueft. */
export const RECOVERY_CODE_SET_CREATED_ACTION =
  "admin.mfa.recovery_code_set.created";
export const RECOVERY_CODE_SET_REPLACED_ACTION =
  "admin.mfa.recovery_code_set.replaced";
export const RECOVERY_CODE_USED_ACTION = "admin.mfa.recovery_code.used";

export const RECOVERY_CODE_SET_TARGET_TYPE = "admin_mfa_recovery_code_set";

const HEX_PATTERN = /^[0-9A-F]{32}$/;
const HEX_INPUT_PATTERN = /^[0-9A-Fa-f-]+$/;
const DISPLAY_PATTERN = /^(?:[0-9A-F]{4}-){7}[0-9A-F]{4}$/;

/** Schmale SQL-Schnittstelle einer vom Aufrufer kontrollierten Transaktion. */
export type RecoveryCodeSqlClient = Pick<PoolClient, "query">;

export type RecoveryCodeAuditWriter = (
  executor: SqlQueryable,
  event: AuditEventInput,
) => Promise<void>;

export interface RecoveryCodeSet {
  codeSetId: string;
  actorId: string;
  createdAt: Date;
  /** Klartextcodes; nur hier und nur einmalig an den Aufrufer. */
  codes: string[];
}

export interface RecoveryCodeConsumption {
  consumed: boolean;
  codeSetId?: string;
}

export interface RecoveryCodeServiceOptions {
  pool: Pool;
  now?: () => Date;
  /** Optionaler Audit-Port; Standard ist der vorhandene transaktionale Schreiber. */
  auditWriter?: RecoveryCodeAuditWriter;
}

export interface RecoveryCodeService {
  /** Legt den ersten Codesatz an; ein aktiver Satz ist ein Konflikt. */
  create(actorId: string): Promise<RecoveryCodeSet>;
  /** Entwertet den aktiven Satz und legt atomar einen neuen an. */
  replace(actorId: string): Promise<RecoveryCodeSet>;
  /**
   * Verbraucht einen Code innerhalb der vom Auth-Service uebergebenen
   * Transaktion. Ohne offene Transaktion des Aufrufers gibt es keine
   * Wirksamkeit.
   */
  consume(
    actorId: string,
    code: string,
    executor: RecoveryCodeSqlClient,
  ): Promise<RecoveryCodeConsumption>;
}

/** Konflikt: fuer das Konto existiert bereits ein aktiver Codesatz. */
export class RecoveryCodeSetExistsError extends Error {
  constructor() {
    super("Fuer das Konto existiert bereits ein aktiver Codesatz");
    this.name = "RecoveryCodeSetExistsError";
  }
}

/** Ungueltige Kontokennung; die Meldung enthaelt keine Eingabewerte. */
export class RecoveryCodeActorError extends Error {
  constructor() {
    super("Eine stabile actor_id ist erforderlich");
    this.name = "RecoveryCodeActorError";
  }
}

/**
 * Erzeugt einen Code aus genau 16 Zufallsbytes (128 Bit), dargestellt als
 * acht Gruppen zu vier Hexzeichen.
 */
export function generateRecoveryCode(): string {
  const hex = randomBytes(RECOVERY_CODE_RANDOM_BYTES)
    .toString("hex")
    .toUpperCase();
  return hex.match(/.{4}/g)?.join("-") ?? "";
}

/** Erzeugt genau zehn unterschiedliche Codes mit je 128 Zufallsbits. */
export function generateRecoveryCodeSet(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    generateRecoveryCode(),
  );
}

/**
 * Erlaubt ausschliesslich das Entfernen der Darstellungsbindestriche und die
 * Vereinheitlichung der Grossschreibung. Anschliessend sind exakt 32
 * Hexzeichen erforderlich. Leerzeichen, Unicode-Varianten und jede andere
 * Transformation werden abgelehnt.
 */
export function normalizeRecoveryCode(value: unknown): string | null {
  if (typeof value !== "string" || !HEX_INPUT_PATTERN.test(value)) {
    return null;
  }
  const normalized = value.replace(/-/g, "").toUpperCase();
  return HEX_PATTERN.test(normalized) ? normalized : null;
}

/**
 * Bildet den gespeicherten SHA-256-Hash. Die Domaenentrennung und die stabile
 * actor_id binden den Hash an Zweck und Konto; derselbe Code ergibt fuer
 * verschiedene Konten verschiedene Hashes.
 */
export function hashRecoveryCode(
  actorId: string,
  normalizedCode: string,
): Buffer {
  assertActorId(actorId);
  if (!HEX_PATTERN.test(normalizedCode)) {
    throw new Error("Wiederherstellungscode ist ungueltig");
  }
  return createHash("sha256")
    .update(RECOVERY_CODE_HASH_DOMAIN, "utf8")
    .update("\u0000", "utf8")
    .update(actorId, "utf8")
    .update("\u0000", "utf8")
    .update(normalizedCode, "utf8")
    .digest();
}

/** Formatiert einen normalisierten Code fuer die Anzeige. */
export function formatRecoveryCode(normalizedCode: string): string {
  if (!HEX_PATTERN.test(normalizedCode)) {
    throw new Error("Wiederherstellungscode ist ungueltig");
  }
  return normalizedCode.match(/.{4}/g)?.join("-") ?? "";
}

/** Prueft die Darstellung; nur fuer Tests und Anzeige, nie fuer die Speicherung. */
export function isDisplayedRecoveryCode(value: string): boolean {
  return DISPLAY_PATTERN.test(value);
}

function assertActorId(actorId: string): void {
  if (typeof actorId !== "string" || actorId.trim() === "") {
    throw new RecoveryCodeActorError();
  }
}

function assertValidDate(value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("Die injizierte Serveruhr liefert keinen gueltigen Zeitpunkt");
  }
}

class DefaultRecoveryCodeService implements RecoveryCodeService {
  private readonly pool: Pool;
  private readonly now: () => Date;
  private readonly auditWriter: RecoveryCodeAuditWriter | undefined;

  constructor(options: RecoveryCodeServiceOptions) {
    this.pool = options.pool;
    this.now = options.now ?? (() => new Date());
    this.auditWriter = options.auditWriter;
  }

  async create(actorId: string): Promise<RecoveryCodeSet> {
    assertActorId(actorId);
    return this.withTransaction(async (client) => {
      await lockActor(client, actorId);
      const active = await selectActiveSetForUpdate(client, actorId);
      if (active !== null) {
        throw new RecoveryCodeSetExistsError();
      }
      return this.insertSet(client, actorId);
    });
  }

  async replace(actorId: string): Promise<RecoveryCodeSet> {
    assertActorId(actorId);
    return this.withTransaction(async (client) => {
      await lockActor(client, actorId);
      const active = await selectActiveSetForUpdate(client, actorId);
      const createdAt = this.now();
      assertValidDate(createdAt);

      const codeSetId = randomUUID();
      const codes = generateRecoveryCodeSet();
      const hashes = codes.map((code) => {
        const normalized = normalizeRecoveryCode(code);
        if (normalized === null) {
          throw new Error("Erzeugter Wiederherstellungscode ist ungueltig");
        }
        return hashRecoveryCode(actorId, normalized);
      });

      let replacedCodeSetId: string | null = null;
      if (active !== null) {
        const invalidated = await client.query(
          [
            "update admin_mfa_recovery_code_sets",
            "   set invalidated_at = $2",
            " where id = $1",
            "   and invalidated_at is null",
            "returning id::text as id",
          ].join("\n"),
          [active.id, createdAt],
        );
        if ((invalidated.rowCount ?? 0) !== 1) {
          throw new Error("Aktiver Codesatz konnte nicht entwertet werden");
        }
        replacedCodeSetId = active.id;
      }

      await insertSet(client, codeSetId, actorId, createdAt);
      await insertCodes(client, codeSetId, actorId, hashes, createdAt);
      await this.writeAudit(client, {
        at: createdAt,
        actorType: "admin",
        actorId,
        action: RECOVERY_CODE_SET_REPLACED_ACTION,
        targetType: RECOVERY_CODE_SET_TARGET_TYPE,
        targetId: codeSetId,
        details: {
          code_set_id: codeSetId,
          replaced_code_set_id: replacedCodeSetId,
          code_count: codes.length,
        },
      });

      return { codeSetId, actorId, createdAt, codes };
    });
  }

  async consume(
    actorId: string,
    code: string,
    executor: RecoveryCodeSqlClient,
  ): Promise<RecoveryCodeConsumption> {
    assertActorId(actorId);
    const normalized = normalizeRecoveryCode(code);
    if (normalized === null) {
      return { consumed: false };
    }
    const consumedAt = this.now();
    assertValidDate(consumedAt);
    const codeHash = hashRecoveryCode(actorId, normalized);

    // Bedingtes UPDATE: Sperre, Verbrauchspruefung und Zustandswechsel sind
    // eine Anweisung. Zwei parallele Aufrufe koennen hoechstens einmal
    // used_at setzen; verbrauchte und fremde Codes treffen keine Zeile.
    const result = await executor.query<{
      id: string;
      code_set_id: string;
    }>(
      [
        "update admin_mfa_recovery_codes as c",
        "   set used_at = $3",
        "  from admin_mfa_recovery_code_sets as s",
        " where c.code_set_id = s.id",
        "   and c.actor_id = $2",
        "   and c.code_hash = $1",
        "   and c.used_at is null",
        "   and s.actor_id = $2",
        "   and s.invalidated_at is null",
        "returning c.id::text as id, c.code_set_id::text as code_set_id",
      ].join("\n"),
      [codeHash, actorId, consumedAt],
    );

    const row = result.rows[0];
    if (row === undefined) {
      return { consumed: false };
    }

    await this.writeAudit(executor, {
      at: consumedAt,
      actorType: "admin",
      actorId,
      action: RECOVERY_CODE_USED_ACTION,
      targetType: RECOVERY_CODE_SET_TARGET_TYPE,
      targetId: row.code_set_id,
      details: {
        code_set_id: row.code_set_id,
        entry_id: row.id,
      },
    });

    return { consumed: true, codeSetId: row.code_set_id };
  }

  private async insertSet(
    client: RecoveryCodeSqlClient,
    actorId: string,
  ): Promise<RecoveryCodeSet> {
    const createdAt = this.now();
    assertValidDate(createdAt);
    const codeSetId = randomUUID();
    const codes = generateRecoveryCodeSet();
    const hashes = codes.map((code) => {
      const normalized = normalizeRecoveryCode(code);
      if (normalized === null) {
        throw new Error("Erzeugter Wiederherstellungscode ist ungueltig");
      }
      return hashRecoveryCode(actorId, normalized);
    });

    await insertSet(client, codeSetId, actorId, createdAt);
    await insertCodes(client, codeSetId, actorId, hashes, createdAt);
    await this.writeAudit(client, {
      at: createdAt,
      actorType: "admin",
      actorId,
      action: RECOVERY_CODE_SET_CREATED_ACTION,
      targetType: RECOVERY_CODE_SET_TARGET_TYPE,
      targetId: codeSetId,
      details: {
        code_set_id: codeSetId,
        code_count: codes.length,
      },
    });

    return { codeSetId, actorId, createdAt, codes };
  }

  private async writeAudit(
    executor: SqlQueryable,
    event: AuditEventInput,
  ): Promise<void> {
    if (this.auditWriter !== undefined) {
      await this.auditWriter(executor, event);
      return;
    }
    await insertAuditEvent(executor, event);
  }

  private async withTransaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let open = false;
    try {
      await client.query("begin");
      open = true;
      const result = await operation(client);
      await client.query("commit");
      open = false;
      return result;
    } catch (error) {
      if (open) {
        try {
          await client.query("rollback");
        } catch {
          // Der urspruengliche Fehler bleibt massgeblich.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

async function lockActor(
  client: RecoveryCodeSqlClient,
  actorId: string,
): Promise<void> {
  // Serialisiert erstmalige Erzeugung und Austausch je Konto, auch wenn noch
  // kein Satz zum Sperren existiert.
  await client.query(
    "select pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [actorId],
  );
}

async function selectActiveSetForUpdate(
  client: RecoveryCodeSqlClient,
  actorId: string,
): Promise<{ id: string } | null> {
  const result = await client.query<{ id: string }>(
    [
      "select id::text as id",
      "  from admin_mfa_recovery_code_sets",
      " where actor_id = $1",
      "   and invalidated_at is null",
      "   for update",
    ].join("\n"),
    [actorId],
  );
  return result.rows[0] ?? null;
}

async function insertSet(
  client: RecoveryCodeSqlClient,
  codeSetId: string,
  actorId: string,
  createdAt: Date,
): Promise<void> {
  await client.query(
    [
      "insert into admin_mfa_recovery_code_sets",
      "  (id, actor_id, created_at, invalidated_at)",
      "values ($1, $2, $3, null)",
    ].join("\n"),
    [codeSetId, actorId, createdAt],
  );
}

async function insertCodes(
  client: RecoveryCodeSqlClient,
  codeSetId: string,
  actorId: string,
  hashes: Buffer[],
  createdAt: Date,
): Promise<void> {
  for (const hash of hashes) {
    await client.query(
      [
        "insert into admin_mfa_recovery_codes",
        "  (id, code_set_id, actor_id, code_hash, created_at, used_at)",
        "values ($1, $2, $3, $4, $5, null)",
      ].join("\n"),
      [randomUUID(), codeSetId, actorId, hash, createdAt],
    );
  }
}

/** Explizit aufrufbarer Kern ohne automatische Erzeugung beim Serverstart. */
export function createRecoveryCodeService(
  options: RecoveryCodeServiceOptions,
): RecoveryCodeService {
  return new DefaultRecoveryCodeService(options);
}
