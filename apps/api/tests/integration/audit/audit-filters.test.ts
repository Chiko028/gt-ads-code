import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  adminHeaders,
  BASE_TIME,
  createAuditTestContext,
  type AuditTestContext,
} from "./support.js";

const FROM = BASE_TIME;
const TO = BASE_TIME + 10_000;
const MATCHING_ACTOR = "SYN-CX058-Actor-A";
const MATCHING_ACTION = "SYN-CX058.action.a";
const SECRET = "SYN-CX058-GEHEIM-DETAIL";

let context: AuditTestContext;

beforeAll(async () => {
  context = await createAuditTestContext();
}, 120_000);

beforeEach(async () => {
  await context.pool.query(
    "truncate table audit_events, admin_sessions, operators restart identity cascade",
  );
});

afterAll(async () => {
  await context.close();
}, 30_000);

async function insertEvent(
  at: number,
  actorId: string,
  action: string,
  details: Record<string, unknown> = {},
): Promise<string> {
  const result = await context.pool.query<{ id: string }>(
    [
      "insert into audit_events",
      "  (at, actor_type, actor_id, action, target_type, target_id, details)",
      "values ($1::timestamptz, 'admin', $2, $3, 'device', 'SYN-target', $4)",
      "returning id::text as id",
    ].join("\n"),
    [new Date(at), actorId, action, details],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Audit-Eintrag wurde nicht angelegt");
  }
  return row.id;
}

interface AuditItem {
  id: string;
  at: string;
  actor_id: string | null;
  action: string;
}

describe("CX-058 kombinierte Audit-Filter und Cursor-Pagination", () => {
  it("filtert Zeitraum, Akteur und Aktion mit UND, paginiert bei gleichen Zeitstempeln aufsteigend ohne Luecken und Duplikate und gibt keine Details aus", async () => {
    const matchingIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      matchingIds.push(
        await insertEvent(FROM, MATCHING_ACTOR, MATCHING_ACTION, {
          nested: { token: SECRET },
          note: SECRET,
        }),
      );
    }

    // Gleicher Zeitstempel, aber anderer Akteur bzw. andere Aktion.
    await insertEvent(FROM, "SYN-CX058-Actor-B", MATCHING_ACTION, {
      token: SECRET,
    });
    await insertEvent(FROM, MATCHING_ACTOR, "SYN-CX058.action.b", {
      token: SECRET,
    });
    // to ist exklusiv.
    await insertEvent(TO, MATCHING_ACTOR, MATCHING_ACTION, { token: SECRET });
    // from ist inklusiv; davor liegt ausserhalb.
    await insertEvent(FROM - 1_000, MATCHING_ACTOR, MATCHING_ACTION, {
      token: SECRET,
    });

    const app = await context.buildApp("Admin");
    const cookie = await context.loginCookie(app);

    const from = "2026-05-01T12:00:00+02:00";
    const to = "2026-05-01T12:00:10+02:00";
    const baseUrl =
      "/v1/admin/audit?from=" +
      encodeURIComponent(from) +
      "&to=" +
      encodeURIComponent(to) +
      "&actor_id=" +
      encodeURIComponent(MATCHING_ACTOR) +
      "&action=" +
      encodeURIComponent(MATCHING_ACTION) +
      "&limit=2";

    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string =
        cursor === null
          ? baseUrl
          : baseUrl + "&cursor=" + encodeURIComponent(cursor);
      const response = await app.inject({
        method: "GET",
        url,
        headers: adminHeaders(cookie),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        items: AuditItem[];
        next_cursor: string | null;
      };
      expect(response.body).not.toContain(SECRET);
      for (const item of body.items) {
        expect(item.at).toBe(new Date(FROM).toISOString());
      }
      collected.push(...body.items.map((item) => item.id));
      cursor = body.next_cursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(5);
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(collected).toEqual(matchingIds);
    expect(new Set(collected).size).toBe(matchingIds.length);
  });
});
