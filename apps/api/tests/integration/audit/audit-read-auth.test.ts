import type { FastifyInstance } from "fastify";
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

const MATCHING_ACTOR = "SYN-CX058-Auth-Actor";
const MATCHING_ACTION = "SYN-CX058.auth.action";
const OTHER_ACTOR = "SYN-CX058-Other-Actor";

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
): Promise<void> {
  await context.pool.query(
    [
      "insert into audit_events",
      "  (at, actor_type, actor_id, action, target_type, target_id, details)",
      "values ($1::timestamptz, 'admin', $2, $3, 'device', 'SYN-target', $4::jsonb)",
    ].join("\n"),
    [new Date(at), actorId, action, JSON.stringify({ token: "SYN-GEHEIM" })],
  );
}

interface AuditItemShape {
  id: string;
  action: string;
  actor_id: string | null;
}

function readAudit(
  app: FastifyInstance,
  query: string,
  cookie?: string,
) {
  return app.inject({
    method: "GET",
    url: "/v1/admin/audit" + query,
    headers: adminHeaders(cookie),
  });
}

describe("CX-058 Zugriffsschutz und Validierung der Audit-Leseroute", () => {
  it("verweigert anonym 401 und Operator 403, liefert Admin gefilterte Daten und beantwortet ungueltige Intervalle, Cursor und Limits mit 400, ohne SQL-Metazeichen auszufuehren", async () => {
    await insertEvent(BASE_TIME, MATCHING_ACTOR, MATCHING_ACTION);
    await insertEvent(BASE_TIME, OTHER_ACTOR, MATCHING_ACTION);
    await insertEvent(BASE_TIME, MATCHING_ACTOR, "SYN-CX058.other.action");

    const anonymousApp = await context.buildApp(null);
    const anonymous = await readAudit(anonymousApp, "?actor_id=" + MATCHING_ACTOR);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe("unauthorized");

    const operatorApp = await context.buildApp("Operator");
    const operatorCookie = await context.loginCookie(operatorApp);
    const operator = await readAudit(operatorApp, "", operatorCookie);
    expect(operator.statusCode).toBe(403);
    expect(operator.json().error.code).toBe("forbidden");

    const adminApp = await context.buildApp("Admin");
    const cookie = await context.loginCookie(adminApp);
    const filtered = await readAudit(
      adminApp,
      "?from=" +
        encodeURIComponent("2026-05-01T12:00:00+02:00") +
        "&to=" +
        encodeURIComponent("2026-05-01T12:00:10+02:00") +
        "&actor_id=" +
        encodeURIComponent(MATCHING_ACTOR) +
        "&action=" +
        encodeURIComponent(MATCHING_ACTION),
      cookie,
    );
    expect(filtered.statusCode).toBe(200);
    const filteredBody = filtered.json() as { items: AuditItemShape[] };
    expect(filteredBody.items).toHaveLength(1);
    const item = filteredBody.items[0] as AuditItemShape;
    expect(item.actor_id).toBe(MATCHING_ACTOR);
    expect(item.action).toBe(MATCHING_ACTION);

    const invalidQueries = [
      "?from=2026-05-01T10:00:00",
      "?to=2026-05-01T10:00:00",
      "?from=2026-05-01T10:00:00Z&to=2026-02-30T10:00:00Z",
      "?from=2026-05-01T10:00:00Z&to=2026-05-01T10:00:00Z",
      "?from=2026-05-01T10:00:01Z&to=2026-05-01T10:00:00Z",
      "?from=2026-05-01T10:00:00Z&from=2026-05-01T10:01:00Z",
      "?from=2026-05-01T10:00:00Z&to=2026-05-01T10:00:60Z",
      "?from=",
      "?to=",
      "?actor_id=",
      "?action=",
      "?limit=0",
      "?limit=101",
      "?limit=1.5",
      "?limit=-1",
      "?limit=abc",
      "?limit=",
      "?limit=1&limit=2",
      "?cursor=abc",
      "?cursor=-1",
      "?cursor=1.5",
      "?cursor=",
      "?cursor=9223372036854775808",
      "?foo=1",
      "?limit=1&unknown=2",
      "?from=" + encodeURIComponent("2026-05-01T10:00:00Z' OR '1'='1"),
    ];

    for (const query of invalidQueries) {
      const response = await readAudit(adminApp, query, cookie);
      expect(response.statusCode, query).toBe(400);
      const body = response.json() as {
        error: { code: string; message: string; request_id: string };
      };
      expect(body.error.code, query).toBe("invalid_request");
      expect(body.error.message, query).toBe("Die Anfrage ist ungueltig.");
      expect(typeof body.error.request_id, query).toBe("string");
      expect(Object.keys(body), query).toEqual(["error"]);
      expect(response.body, query).not.toContain("OR '1'='1'");
    }

    // Exakte Textfilter: SQL-Metazeichen bleiben Bindewerte und treffen nichts.
    const metaActor = await readAudit(
      adminApp,
      "?actor_id=" + encodeURIComponent("SYN-CX058-A' OR '1'='1"),
      cookie,
    );
    expect(metaActor.statusCode).toBe(200);
    expect((metaActor.json() as { items: AuditItemShape[] }).items).toEqual([]);

    const metaAction = await readAudit(
      adminApp,
      "?action=" +
        encodeURIComponent("x'; drop table audit_events; --"),
      cookie,
    );
    expect(metaAction.statusCode).toBe(200);
    expect((metaAction.json() as { items: AuditItemShape[] }).items).toEqual([]);

    // Die Tabelle lebt weiter; die Abfrage wurde nicht veraendert.
    const unfiltered = await readAudit(adminApp, "", cookie);
    expect(unfiltered.statusCode).toBe(200);
    expect(
      (unfiltered.json() as { items: AuditItemShape[] }).items.length,
    ).toBeGreaterThan(0);
  });
});
