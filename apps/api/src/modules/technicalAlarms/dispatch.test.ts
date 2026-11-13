import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  TECHNICAL_ALARM_DELIVERY_AUDIT_FIELDS,
  TECHNICAL_ALARM_DELIVERY_BLOCKED_ACTION,
  TECHNICAL_ALARM_DELIVERY_FAILED_ACTION,
  TECHNICAL_ALARM_DELIVERY_RETRY_ACTION,
  TECHNICAL_ALARM_DELIVERY_SENT_ACTION,
  TECHNICAL_ALARM_OPENED_ACTION,
  TelegramSender,
  dispatchPending,
  type DispatchPendingOptions,
  type DispatchPendingResult,
  type TelegramSendMessageRequest,
  type TelegramTransport,
  type TelegramTransportResponse,
} from "./index.js";

const BASE_TIME = Date.parse("2026-08-01T00:00:00.000Z");
const TOKEN = "123456:SYN-CX-029-TOKEN";
const CHAT_ID = "987654321";
const TARGET = { botToken: TOKEN, chatId: CHAT_ID };
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);
const MIGRATIONS = [
  "0001_gt_ads_001.up.sql",
  "0002_gt_ads_004_telemetry.up.sql",
  "0003_cx_011_telemetry_rollups.up.sql",
  "0004_cx_012_remote_control.up.sql",
  "0005_cx_013_control_config.up.sql",
  "0006_cx_028_technical_alarms.up.sql",
];

interface OutboxRow {
  outbox_id: string;
  status: string;
  attempt_count: number;
  next_attempt_at: Date | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_error_code: string | null;
}

interface Counts {
  episodes: number;
  outbox: number;
  audit: number;
}

let maintenancePool: Pool | null = null;
let pool: Pool | null = null;
let databaseName = "";
let nowMs = BASE_TIME;

function baseConnection(): {
  host: string;
  port: number;
  user: string;
  database: string;
} {
  const host = process.env.PGHOST;
  const user = process.env.PGUSER;
  const database = process.env.PGDATABASE;
  if (host === undefined || user === undefined || database === undefined) {
    throw new Error("CX-029 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

async function readMigration(name: string): Promise<string> {
  return readFile(join(MIGRATIONS_DIR, name), "utf8");
}

async function resetTables(): Promise<void> {
  await (pool as Pool).query(
    [
      "truncate table technical_alarm_outbox,",
      "  technical_alarm_episodes, technical_alarm_resource_state",
      "  restart identity",
    ].join(" "),
  );
  await (pool as Pool).query("delete from audit_events");
}

async function createOrder(
  resourceId: string,
  errorCode: string,
  faultStartedAtMs: number,
  atMs: number,
): Promise<{ episodeId: number; outboxId: number }> {
  const episode = await (pool as Pool).query<{ episode_id: string }>(
    [
      "insert into technical_alarm_episodes",
      "  (resource_id, status, error_code, fault_started_at, detected_at,",
      "   opened_evaluation_id, opened_evaluation_version)",
      "values ($1, 'open', $2, $3::timestamptz, $4::timestamptz, $5, 1)",
      "returning episode_id::text as episode_id",
    ].join("\n"),
    [
      resourceId,
      errorCode,
      new Date(faultStartedAtMs),
      new Date(atMs),
      "eval-" + resourceId,
    ],
  );
  const episodeId = Number(episode.rows[0].episode_id);
  const outbox = await (pool as Pool).query<{ outbox_id: string }>(
    [
      "insert into technical_alarm_outbox",
      "  (episode_id, resource_id, message_kind, status, attempt_count,",
      "   next_attempt_at, lease_owner, lease_expires_at, last_error_code,",
      "   created_at, updated_at)",
      "values ($1::bigint, $2, 'technical_alarm_opened', 'pending', 0,",
      "        $3::timestamptz, null, null, null, $3::timestamptz, $3::timestamptz)",
      "returning outbox_id::text as outbox_id",
    ].join("\n"),
    [episodeId, resourceId, new Date(atMs)],
  );
  await (pool as Pool).query(
    [
      "insert into audit_events",
      "  (at, actor_type, actor_id, action, target_type, target_id, details)",
      "values ($1::timestamptz, 'system', null, $2,",
      "        'technical_alarm_episode', $3, $4::jsonb)",
    ].join("\n"),
    [
      new Date(atMs),
      TECHNICAL_ALARM_OPENED_ACTION,
      String(episodeId),
      JSON.stringify({ alarm_id: String(episodeId) }),
    ],
  );
  return { episodeId, outboxId: Number(outbox.rows[0].outbox_id) };
}

async function settleOutbox(outboxId: number): Promise<OutboxRow> {
  const result = await (pool as Pool).query<OutboxRow>(
    [
      "select outbox_id::text as outbox_id, status, attempt_count,",
      "       next_attempt_at, lease_owner, lease_expires_at, last_error_code",
      "  from technical_alarm_outbox",
      " where outbox_id = $1::bigint",
    ].join("\n"),
    [outboxId],
  );
  return result.rows[0];
}

async function counts(): Promise<Counts> {
  const result = await (pool as Pool).query<Counts>(
    [
      "select",
      "  (select count(*) from technical_alarm_episodes)::int as episodes,",
      "  (select count(*) from technical_alarm_outbox)::int as outbox,",
      "  (select count(*) from audit_events)::int as audit",
    ].join("\n"),
  );
  return result.rows[0];
}

async function auditCount(action: string, targetId: string): Promise<number> {
  const result = await (pool as Pool).query<{ count: number }>(
    [
      "select count(*)::int as count from audit_events",
      " where action = $1 and target_id = $2",
    ].join("\n"),
    [action, targetId],
  );
  return result.rows[0].count;
}

async function auditDetailsText(
  action: string,
  targetId: string,
): Promise<string> {
  const result = await (pool as Pool).query<{ text: string }>(
    [
      "select details::text as text from audit_events",
      " where action = $1 and target_id = $2",
      " order by id desc limit 1",
    ].join("\n"),
    [action, targetId],
  );
  return result.rows[0].text;
}

interface SentCall {
  request: TelegramSendMessageRequest;
  signal: AbortSignal;
}

interface TransportDouble {
  transport: TelegramTransport;
  calls: SentCall[];
}

function makeTransport(
  handler: (
    call: SentCall,
    index: number,
  ) => Promise<TelegramTransportResponse>,
): TransportDouble {
  const calls: SentCall[] = [];
  const transport: TelegramTransport = {
    sendMessage(request, options) {
      const call: SentCall = { request, signal: options.signal };
      const index = calls.length;
      calls.push(call);
      return handler(call, index);
    },
  };
  return { transport, calls };
}

const OK_RESPONSE: TelegramTransportResponse = {
  status: 200,
  body: { ok: true, result: { message_id: 1 } },
};

function runDispatch(
  overrides: Partial<DispatchPendingOptions> = {},
): Promise<DispatchPendingResult> {
  const now = overrides.now ?? (() => new Date(nowMs));
  return dispatchPending({
    pool: pool as Pool,
    sender: null,
    batchLimit: 10,
    leaseSeconds: 60,
    sendTimeoutMs: 200,
    ...overrides,
    now,
  });
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = ("gtads_cx029_" + process.pid + "_" + Date.now().toString(36))
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(databaseName));

  pool = new Pool({ ...base, database: databaseName });
  try {
    for (const migration of MIGRATIONS) {
      await pool.query(await readMigration(migration));
    }
  } catch (error) {
    await pool.end();
    pool = null;
    throw error;
  }
}, 30_000);

afterAll(async () => {
  try {
    if (pool !== null) {
      await pool.end();
    }
  } finally {
    try {
      if (maintenancePool !== null && databaseName !== "") {
        await maintenancePool.query(
          "drop database if exists " + quoteIdentifier(databaseName),
        );
      }
    } finally {
      if (maintenancePool !== null) {
        await maintenancePool.end();
      }
    }
  }
});

beforeEach(async () => {
  await resetTables();
  nowMs = BASE_TIME;
});

describe("CX-029 austauschbarer Telegram-Versand", () => {
  it("beansprucht einen Auftrag bei konkurrierenden Laeufen nur einmal und sendet bestaetigten Erfolg nach Neustart nicht erneut", async () => {
    const order = await createOrder(
      "SYN-CX-029-T1",
      "player_error",
      BASE_TIME,
      BASE_TIME,
    );
    nowMs = BASE_TIME + 10_000;

    const double = makeTransport(async () => OK_RESPONSE);
    const sender = new TelegramSender({
      transport: double.transport,
      target: TARGET,
    });

    const [first, second] = await Promise.all([
      runDispatch({ sender, batchLimit: 1 }),
      runDispatch({ sender, batchLimit: 1 }),
    ]);

    expect(first.claimed + second.claimed).toBe(1);
    expect(first.sent + second.sent).toBe(1);
    expect(double.calls.length).toBe(1);

    const stored = await settleOutbox(order.outboxId);
    expect(stored.status).toBe("sent");
    expect(stored.attempt_count).toBe(1);
    expect(stored.next_attempt_at).toBeNull();
    expect(stored.lease_owner).toBeNull();
    expect(stored.last_error_code).toBeNull();
    expect(await auditCount(TECHNICAL_ALARM_DELIVERY_SENT_ACTION, String(order.outboxId))).toBe(1);

    // Neustart: eine neue Instanz mit frischem Transport sieht den Erfolg und
    // sendet denselben Auftrag nicht erneut.
    const afterRestart = makeTransport(async () => OK_RESPONSE);
    const restarted = await runDispatch({
      sender: new TelegramSender({
        transport: afterRestart.transport,
        target: TARGET,
      }),
      batchLimit: 10,
    });
    expect(restarted.claimed).toBe(0);
    expect(restarted.sent).toBe(0);
    expect(afterRestart.calls.length).toBe(0);
    expect((await settleOutbox(order.outboxId)).status).toBe("sent");
    expect(await auditCount(TECHNICAL_ALARM_DELIVERY_SENT_ACTION, String(order.outboxId))).toBe(1);
  });

  it("fuehrt Erfolg, 429, Timeout, 5xx und endgueltige 4xx in die festgelegten Zustaende und wartet next_attempt_at ab", async () => {
    const hangUntilAborted = (
      call: SentCall,
    ): Promise<TelegramTransportResponse> =>
      new Promise<TelegramTransportResponse>((_resolve, reject) => {
        if (call.signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        call.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });

    const cases: Array<{
      name: string;
      response: (
        call: SentCall,
        index: number,
      ) => Promise<TelegramTransportResponse>;
      seedAttemptCount?: number;
      timeoutMs?: number;
      expected: {
        status: string;
        attemptCount: number;
        nextOffsetMs: number | null;
        lastErrorCode: string | null;
        action: string;
      };
      noRetryBeforeOffsetMs?: number;
    }> = [
      {
        name: "Telegram-Erfolg",
        response: async () => OK_RESPONSE,
        expected: {
          status: "sent",
          attemptCount: 1,
          nextOffsetMs: null,
          lastErrorCode: null,
          action: TECHNICAL_ALARM_DELIVERY_SENT_ACTION,
        },
      },
      {
        name: "HTTP 429 mit Retry-After",
        response: async () => ({
          status: 429,
          headers: { "Retry-After": "120" },
          body: { ok: false, error_code: 429 },
        }),
        expected: {
          status: "pending",
          attemptCount: 1,
          nextOffsetMs: 120_000,
          lastErrorCode: "telegram_rate_limited",
          action: TECHNICAL_ALARM_DELIVERY_RETRY_ACTION,
        },
        noRetryBeforeOffsetMs: 119_999,
      },
      {
        name: "HTTP 429 mit Telegram retry_after",
        response: async () => ({
          status: 429,
          body: {
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 45 },
          },
        }),
        expected: {
          status: "pending",
          attemptCount: 1,
          nextOffsetMs: 45_000,
          lastErrorCode: "telegram_rate_limited",
          action: TECHNICAL_ALARM_DELIVERY_RETRY_ACTION,
        },
        noRetryBeforeOffsetMs: 44_999,
      },
      {
        name: "Timeout",
        response: hangUntilAborted,
        timeoutMs: 20,
        expected: {
          status: "pending",
          attemptCount: 1,
          nextOffsetMs: 30_000,
          lastErrorCode: "timeout",
          action: TECHNICAL_ALARM_DELIVERY_RETRY_ACTION,
        },
        noRetryBeforeOffsetMs: 29_999,
      },
      {
        name: "HTTP 5xx",
        response: async () => ({ status: 503, body: { ok: false } }),
        expected: {
          status: "pending",
          attemptCount: 1,
          nextOffsetMs: 30_000,
          lastErrorCode: "telegram_server_error",
          action: TECHNICAL_ALARM_DELIVERY_RETRY_ACTION,
        },
        noRetryBeforeOffsetMs: 29_999,
      },
      {
        name: "endgueltige 4xx",
        response: async () => ({
          status: 400,
          body: { ok: false, error_code: 400, description: "Bad Request" },
        }),
        expected: {
          status: "failed",
          attemptCount: 1,
          nextOffsetMs: null,
          lastErrorCode: "telegram_client_error",
          action: TECHNICAL_ALARM_DELIVERY_FAILED_ACTION,
        },
      },
      {
        name: "5xx beim fuenften Versuch",
        response: async () => ({ status: 500, body: { ok: false } }),
        seedAttemptCount: 4,
        expected: {
          status: "failed",
          attemptCount: 5,
          nextOffsetMs: null,
          lastErrorCode: "telegram_server_error",
          action: TECHNICAL_ALARM_DELIVERY_FAILED_ACTION,
        },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      await resetTables();
      const order = await createOrder(
        "SYN-CX-029-T2-" + index,
        "player_error",
        BASE_TIME,
        BASE_TIME,
      );
      if (testCase.seedAttemptCount !== undefined) {
        await (pool as Pool).query(
          "update technical_alarm_outbox set attempt_count = $1 where outbox_id = $2::bigint",
          [testCase.seedAttemptCount, order.outboxId],
        );
      }
      nowMs = BASE_TIME + 5000;
      const startedAt = nowMs;
      const double = makeTransport(testCase.response);
      const sender = new TelegramSender({
        transport: double.transport,
        target: TARGET,
      });

      const result = await runDispatch({
        sender,
        batchLimit: 1,
        sendTimeoutMs: testCase.timeoutMs,
      });
      expect(result.claimed, testCase.name).toBe(1);
      expect(double.calls.length, testCase.name).toBe(1);

      const stored = await settleOutbox(order.outboxId);
      expect(stored.status, testCase.name).toBe(testCase.expected.status);
      expect(stored.attempt_count, testCase.name).toBe(
        testCase.expected.attemptCount,
      );
      expect(stored.last_error_code, testCase.name).toBe(
        testCase.expected.lastErrorCode,
      );
      expect(
        stored.next_attempt_at === null
          ? null
          : stored.next_attempt_at.getTime() - startedAt,
        testCase.name,
      ).toBe(testCase.expected.nextOffsetMs);
      expect(
        await auditCount(testCase.expected.action, String(order.outboxId)),
        testCase.name,
      ).toBe(1);

      if (testCase.noRetryBeforeOffsetMs !== undefined) {
        const callsBefore = double.calls.length;
        nowMs = startedAt + testCase.noRetryBeforeOffsetMs;
        const early = await runDispatch({
          sender,
          batchLimit: 1,
          sendTimeoutMs: testCase.timeoutMs,
        });
        expect(early.claimed, testCase.name).toBe(0);
        expect(early.retried, testCase.name).toBe(0);
        expect(double.calls.length, testCase.name).toBe(callsBefore);
        expect(
          (await settleOutbox(order.outboxId)).attempt_count,
          testCase.name,
        ).toBe(testCase.expected.attemptCount);
      }
    }
  });

  it("blockiert ohne Zielkonfiguration oder Transport sichtbar und verarbeitet nach Behebung denselben Auftrag", async () => {
    nowMs = BASE_TIME + 10_000;
    const first = await createOrder(
      "SYN-CX-029-T3-A",
      "sync_error",
      BASE_TIME,
      BASE_TIME,
    );
    const unused = makeTransport(async () => OK_RESPONSE);
    const withoutTarget = new TelegramSender({
      transport: unused.transport,
      target: null,
    });

    const blockedByTarget = await runDispatch({
      sender: withoutTarget,
      batchLimit: 1,
    });
    expect(blockedByTarget.blocked).toBe(1);
    expect(blockedByTarget.sent).toBe(0);
    const storedA = await settleOutbox(first.outboxId);
    expect(storedA.status).toBe("pending");
    expect(storedA.attempt_count).toBe(0);
    expect(storedA.last_error_code).toBe("target_missing");
    expect(storedA.next_attempt_at?.getTime()).toBe(BASE_TIME);
    expect(unused.calls.length).toBe(0);
    expect((await counts()).episodes).toBe(1);
    expect(
      await auditCount(TECHNICAL_ALARM_OPENED_ACTION, String(first.episodeId)),
    ).toBe(1);
    expect(
      await auditCount(
        TECHNICAL_ALARM_DELIVERY_BLOCKED_ACTION,
        String(first.outboxId),
      ),
    ).toBe(1);

    const fixed = makeTransport(async () => OK_RESPONSE);
    const sentAfterFix = await runDispatch({
      sender: new TelegramSender({ transport: fixed.transport, target: TARGET }),
      batchLimit: 1,
    });
    expect(sentAfterFix.sent).toBe(1);
    expect(fixed.calls.length).toBe(1);
    expect((await settleOutbox(first.outboxId)).status).toBe("sent");

    const second = await createOrder(
      "SYN-CX-029-T3-B",
      "overheat",
      BASE_TIME,
      BASE_TIME,
    );
    nowMs = BASE_TIME + 20_000;
    const blockedBySender = await runDispatch({ sender: null, batchLimit: 1 });
    expect(blockedBySender.blocked).toBe(1);
    expect((await settleOutbox(second.outboxId)).last_error_code).toBe(
      "sender_missing",
    );
    expect(
      await auditCount(TECHNICAL_ALARM_OPENED_ACTION, String(second.episodeId)),
    ).toBe(1);

    const withoutTransport = new TelegramSender({
      transport: null,
      target: TARGET,
    });
    const blockedByTransport = await runDispatch({
      sender: withoutTransport,
      batchLimit: 1,
    });
    expect(blockedByTransport.blocked).toBe(1);
    expect((await settleOutbox(second.outboxId)).last_error_code).toBe(
      "transport_missing",
    );

    const fixedAgain = makeTransport(async () => OK_RESPONSE);
    const sentAfterTransportFix = await runDispatch({
      sender: new TelegramSender({
        transport: fixedAgain.transport,
        target: TARGET,
      }),
      batchLimit: 1,
    });
    expect(sentAfterTransportFix.sent).toBe(1);
    expect((await settleOutbox(second.outboxId)).status).toBe("sent");
    expect((await counts()).episodes).toBe(2);
  });

  it("nimmt abgelaufene Claims wieder auf und protokolliert ohne Token, Ziel-ID, Rohdaten oder Standortdaten", async () => {
    const startedAt = BASE_TIME + 30_000;
    nowMs = startedAt;
    const expired = await createOrder(
      "SYN-CX-029-T4-A",
      "storage_full",
      BASE_TIME,
      BASE_TIME,
    );
    await (pool as Pool).query(
      [
        "update technical_alarm_outbox",
        "   set status = 'leased',",
        "       lease_owner = 'stale-claim',",
        "       lease_expires_at = $1::timestamptz",
        " where outbox_id = $2::bigint",
      ].join("\n"),
      [new Date(startedAt - 1000), expired.outboxId],
    );

    const expiredDouble = makeTransport(async () => OK_RESPONSE);
    const resumed = await runDispatch({
      sender: new TelegramSender({
        transport: expiredDouble.transport,
        target: TARGET,
      }),
      batchLimit: 1,
    });
    expect(resumed.claimed).toBe(1);
    expect(resumed.sent).toBe(1);
    expect(expiredDouble.calls.length).toBe(1);
    const resumedRow = await settleOutbox(expired.outboxId);
    expect(resumedRow.status).toBe("sent");
    expect(resumedRow.attempt_count).toBe(1);
    expect(resumedRow.lease_owner).toBeNull();

    const retry = await createOrder(
      "SYN-CX-029-T4-B",
      "player_error",
      BASE_TIME,
      BASE_TIME,
    );
    nowMs = BASE_TIME + 40_000;
    const retryAt = nowMs;
    const double = makeTransport(async (_call, index) =>
      index === 0 ? { status: 503, body: { ok: false } } : OK_RESPONSE,
    );
    const sender = new TelegramSender({
      transport: double.transport,
      target: TARGET,
    });

    const firstAttempt = await runDispatch({ sender, batchLimit: 1 });
    expect(firstAttempt.retried).toBe(1);
    expect(double.calls.length).toBe(1);
    const failedRow = await settleOutbox(retry.outboxId);
    expect(failedRow.last_error_code).toBe("telegram_server_error");
    expect(failedRow.next_attempt_at?.getTime()).toBe(retryAt + 30_000);

    const retryDetails = await auditDetailsText(
      TECHNICAL_ALARM_DELIVERY_RETRY_ACTION,
      String(retry.outboxId),
    );
    const retryDetailsObject = JSON.parse(retryDetails) as Record<string, unknown>;
    expect(Object.keys(retryDetailsObject).sort()).toEqual(
      [...TECHNICAL_ALARM_DELIVERY_AUDIT_FIELDS].sort(),
    );

    nowMs = retryAt + 30_000;
    const secondAttempt = await runDispatch({ sender, batchLimit: 1 });
    expect(secondAttempt.sent).toBe(1);
    expect(double.calls.length).toBe(2);

    const alarmLine = "Alarm-ID: " + retry.episodeId;
    for (const call of double.calls) {
      const text = call.request.text;
      expect(text).toContain(alarmLine);
      expect(text).toContain("Ressource: SYN-CX-029-T4-B");
      expect(text).toContain("Fehlercode: player_error");
      expect(text).toContain("Zeit (UTC): " + new Date(BASE_TIME).toISOString());
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(CHAT_ID);
      expect(text.toLowerCase()).not.toContain("latitude");
      expect(text.toLowerCase()).not.toContain("location");
      expect(text).not.toContain("observations");
      expect(text).not.toContain("payload");
      expect(text).not.toContain("parse_mode");
    }

    // Der Transport erhaelt Geheimnis und Ziel-ID getrennt vom Text.
    expect(Object.keys(double.calls[1].request).sort()).toEqual([
      "botToken",
      "chatId",
      "text",
    ]);
    expect(double.calls[1].request.botToken).toBe(TOKEN);
    expect(double.calls[1].request.chatId).toBe(CHAT_ID);

    const sentDetails = await auditDetailsText(
      TECHNICAL_ALARM_DELIVERY_SENT_ACTION,
      String(retry.outboxId),
    );
    for (const logged of [retryDetails, sentDetails, failedRow.last_error_code]) {
      if (logged === null) {
        continue;
      }
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain(CHAT_ID);
      expect(logged.toLowerCase()).not.toContain("latitude");
      expect(logged).not.toContain("observations");
    }

    const finalRow = await settleOutbox(retry.outboxId);
    expect(finalRow.status).toBe("sent");
    expect(finalRow.attempt_count).toBe(2);
    expect(finalRow.last_error_code).toBeNull();
    expect(sentDetails).toContain(String(retry.episodeId));
    expect(retryDetails).toContain(String(retry.episodeId));
  });
});
