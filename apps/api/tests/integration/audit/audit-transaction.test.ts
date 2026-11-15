import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { AUDIT_ACTIONS } from "../../../src/modules/audit/repository.js";
import {
  adminHeaders,
  createAuditTestContext,
  type AuditTestContext,
} from "./support.js";

const OPERATOR_PASSWORD = "SYN-CX058-Operator-Passwort";
const USERNAME = "syn-cx058-transaction";

let context: AuditTestContext;

beforeAll(async () => {
  context = await createAuditTestContext();
}, 120_000);

beforeEach(async () => {
  await context.pool.query(
    "truncate table audit_events, admin_sessions, operators restart identity cascade",
  );
  await context.pool.query("drop trigger if exists cx058_fail_audit on audit_events");
  await context.pool.query("drop function if exists cx058_fail_audit()");
});

afterAll(async () => {
  await context.close();
}, 30_000);

async function createOperator(
  app: Awaited<ReturnType<AuditTestContext["buildApp"]>>,
  cookie: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/operators",
    headers: adminHeaders(cookie, { "content-type": "application/json" }),
    payload: { username: USERNAME, password: OPERATOR_PASSWORD },
    remoteAddress: "192.0.2.233",
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { operator_id: string }).operator_id;
}

async function disable(
  app: Awaited<ReturnType<AuditTestContext["buildApp"]>>,
  cookie: string,
  operatorId: string,
) {
  return app.inject({
    method: "POST",
    url: "/v1/admin/operators/" + operatorId + "/disable",
    headers: adminHeaders(cookie, { "content-type": "application/json" }),
    payload: {},
    remoteAddress: "192.0.2.234",
  });
}

describe("CX-058 atomare Audit-Anbindung der Operatorverwaltung", () => {
  it("rollt eine Operator-Aenderung bei erzwungenem Auditfehler zurueck und erzeugt bei idempotenter Wiederholung keinen zweiten Aenderungserfolg", async () => {
    const app = await context.buildApp("Admin");
    const cookie = await context.loginCookie(app);
    const operatorId = await createOperator(app, cookie);

    // Erzwungener Audit-Schreibfehler: die Fachmutation darf nicht committen.
    await context.pool.query(
      [
        "create or replace function cx058_fail_audit()",
        "returns trigger language plpgsql as $$",
        "begin",
        "  raise exception 'CX058 audit failure';",
        "end",
        "$$",
      ].join("\n"),
    );
    await context.pool.query(
      [
        "create trigger cx058_fail_audit",
        "before insert on audit_events",
        "for each row execute function cx058_fail_audit()",
      ].join("\n"),
    );

    let failedStatus: number;
    try {
      const failed = await disable(app, cookie, operatorId);
      failedStatus = failed.statusCode;
      expect(failed.statusCode).toBe(500);
      const body = failed.json() as { error: { code: string } };
      expect(body.error.code).toBe("internal_error");
      expect(failed.body).not.toContain("audit_events");
      expect(failed.body).not.toContain("CX058 audit failure");
    } finally {
      await context.pool.query("drop trigger if exists cx058_fail_audit on audit_events");
      await context.pool.query("drop function if exists cx058_fail_audit()");
    }
    expect(failedStatus).toBe(500);

    const state = await context.pool.query<{ status: string }>(
      "select status from operators where actor_id = $1::uuid",
      [operatorId],
    );
    expect(state.rows[0]?.status).toBe("active");
    const failedAudit = await context.pool.query<{ count: number }>(
      [
        "select count(*)::int as count from audit_events",
        " where action = $1 and target_id = $2",
      ].join("\n"),
      [AUDIT_ACTIONS.operatorDisabled, operatorId],
    );
    expect(failedAudit.rows[0]?.count).toBe(0);

    // Erfolgreiche Sperre und idempotente Wiederholung: genau ein Audit.
    const first = await disable(app, cookie, operatorId);
    expect(first.statusCode).toBe(204);
    const repeated = await disable(app, cookie, operatorId);
    expect(repeated.statusCode).toBe(409);

    const rows = await context.pool.query<{ count: number }>(
      [
        "select count(*)::int as count from audit_events",
        " where action = $1 and target_id = $2",
      ].join("\n"),
      [AUDIT_ACTIONS.operatorDisabled, operatorId],
    );
    expect(rows.rows[0]?.count).toBe(1);
  });
});
