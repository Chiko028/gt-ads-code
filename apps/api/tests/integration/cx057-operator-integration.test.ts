import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../../src/crypto/tokens.js";
import { parsePasswordHash, verifyPassword } from "../../src/crypto/password.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";
import {
  AdminAuthService,
  LEGACY_ADMIN_ACTOR_ID,
} from "../../src/modules/adminAuth/service.js";
import { AUDIT_ACTIONS } from "../../src/modules/audit/repository.js";
import {
  ADMIN_PASSWORD,
  BASE_TIME,
  HOST,
  OPERATOR_PASSWORD,
  createOperatorTestContext,
  type OperatorTestContext,
} from "./cx057/support.js";

interface LoginErrorBody {
  error: { code: string; message: string; request_id: string };
}

interface CreatedOperatorBody {
  operator_id: string;
  username: string;
  status: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let context: OperatorTestContext;

beforeAll(async () => {
  context = await createOperatorTestContext();
}, 180_000);

beforeEach(async () => {
  await context.reset();
});

afterEach(async () => {
  await context.closeApps();
});

afterAll(async () => {
  await context.close();
}, 60_000);

function sessionTokenOf(response: {
  headers: Record<string, unknown>;
}): string {
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw)
    ? (raw[0] as string)
    : (raw as string | undefined);
  if (first === undefined) {
    throw new Error("Set-Cookie fehlt");
  }
  const pair = first.split(";")[0] as string;
  const prefix = ADMIN_SESSION_COOKIE + "=";
  if (!pair.startsWith(prefix)) {
    throw new Error("Unerwartetes Sitzungscookie");
  }
  return pair.slice(prefix.length);
}

function adminHeaders(
  cookie?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { host: HOST, ...extra };
  if (cookie !== undefined) {
    headers.cookie = ADMIN_SESSION_COOKIE + "=" + cookie;
  }
  return headers;
}

async function adminLogin(
  app: FastifyInstance,
  remoteAddress = "192.0.2.10",
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, "content-type": "application/json" },
    payload: { password: ADMIN_PASSWORD },
    remoteAddress,
  });
  expect(response.statusCode).toBe(204);
  return sessionTokenOf(response);
}

async function createOperator(
  app: FastifyInstance,
  cookie: string,
  username: string,
  password = OPERATOR_PASSWORD,
): Promise<CreatedOperatorBody> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/operators",
    headers: adminHeaders(cookie, { "content-type": "application/json" }),
    payload: { username, password },
    remoteAddress: "192.0.2.20",
  });
  expect(response.statusCode).toBe(201);
  return response.json() as CreatedOperatorBody;
}

function loginNamed(
  app: FastifyInstance,
  username: string,
  password = OPERATOR_PASSWORD,
  remoteAddress = "192.0.2.30",
) {
  return app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, "content-type": "application/json" },
    payload: { username, password },
    remoteAddress,
  });
}

function disableOperator(
  app: FastifyInstance,
  cookie: string,
  operatorId: string,
  remoteAddress = "192.0.2.40",
) {
  return app.inject({
    method: "POST",
    url: "/v1/admin/operators/" + operatorId + "/disable",
    headers: adminHeaders(cookie, { "content-type": "application/json" }),
    payload: {},
    remoteAddress,
  });
}

async function installAuditFailureTrigger(
  pool: OperatorTestContext["pool"],
): Promise<void> {
  await pool.query(
    [
      "create or replace function cx057_fail_audit()",
      "returns trigger language plpgsql as $$",
      "begin",
      "  raise exception 'CX057 audit failure';",
      "end",
      "$$",
    ].join("\n"),
  );
  await pool.query(
    [
      "create trigger cx057_fail_audit",
      "before insert on audit_events",
      "for each row execute function cx057_fail_audit()",
    ].join("\n"),
  );
}

async function dropAuditFailureTrigger(
  pool: OperatorTestContext["pool"],
): Promise<void> {
  await pool.query("drop trigger if exists cx057_fail_audit on audit_events");
  await pool.query("drop function if exists cx057_fail_audit()");
}

describe("CX-057 Integrationsgruppe 1: persistente Anlage und Hashparameter", () => {
  it("legt ein Operatorkonto mit echtem scrypt-Hash an, normalisiert die Kennung und speichert weder Passwort noch Hash in Antwort oder Audit", async () => {
    const app = await context.buildApp();
    const adminCookie = await adminLogin(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/operators",
      headers: adminHeaders(adminCookie, { "content-type": "application/json" }),
      payload: { username: "  Syn-CX057-User  ", password: OPERATOR_PASSWORD },
      remoteAddress: "192.0.2.21",
    });
    expect(response.statusCode).toBe(201);
    const created = response.json() as CreatedOperatorBody;

    expect(Object.keys(created).sort()).toEqual([
      "operator_id",
      "status",
      "username",
    ]);
    expect(created.operator_id).toMatch(UUID_PATTERN);
    expect(created.username).toBe("syn-cx057-user");
    expect(created.status).toBe("active");

    // Geheimnisfreiheit der Antwort: weder Klartext noch Hashfragment.
    expect(response.body).not.toContain(OPERATOR_PASSWORD);
    expect(response.body).not.toContain("scrypt");

    const stored = await context.pool.query<{
      username: string;
      password_hash: string;
      status: string;
    }>(
      [
        "select username, password_hash, status",
        "  from operators",
        " where actor_id = $1::uuid",
      ].join("\n"),
      [created.operator_id],
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0].username).toBe("syn-cx057-user");
    expect(stored.rows[0].status).toBe("active");
    const passwordHash = stored.rows[0].password_hash;

    // Echter scrypt-Aufruf mit den versionierten CX-057-Parametern.
    expect(passwordHash.startsWith("scrypt$N=32768,r=8,p=1$")).toBe(true);
    expect(passwordHash).not.toContain(OPERATOR_PASSWORD);
    const parsed = parsePasswordHash(passwordHash);
    expect(parsed.params).toEqual({ N: 32768, r: 8, p: 1, keylen: 64 });
    expect(parsed.salt).toHaveLength(16);
    expect(parsed.hash).toHaveLength(64);
    expect(await verifyPassword(OPERATOR_PASSWORD, passwordHash)).toBe(true);
    expect(
      await verifyPassword(OPERATOR_PASSWORD + "-falsch", passwordHash),
    ).toBe(false);

    const audit = await context.pool.query<{
      actor_id: string | null;
      details: Record<string, unknown>;
    }>(
      [
        "select actor_id, details from audit_events",
        " where action = $1 and target_id = $2",
      ].join("\n"),
      [AUDIT_ACTIONS.operatorCreated, created.operator_id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor_id).toBe(LEGACY_ADMIN_ACTOR_ID);
    expect(audit.rows[0].details.username).toBe("syn-cx057-user");
    const auditJson = JSON.stringify(audit.rows[0].details);
    expect(auditJson).not.toContain(OPERATOR_PASSWORD);
    expect(auditJson).not.toContain("scrypt");
  });

  it("weist normalisierte Duplikate mit 409 ab und lehnt Klartext- oder Feldmanipulationen ohne Persistenz ab", async () => {
    const app = await context.buildApp();
    const adminCookie = await adminLogin(app);

    const first = await createOperator(app, adminCookie, "Syn-CX057-Dup");
    expect(first.username).toBe("syn-cx057-dup");

    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/admin/operators",
      headers: adminHeaders(adminCookie, { "content-type": "application/json" }),
      payload: {
        username: "  SYN-CX057-DUP  ",
        password: OPERATOR_PASSWORD,
      },
      remoteAddress: "192.0.2.22",
    });
    expect(duplicate.statusCode).toBe(409);
    expect((duplicate.json() as LoginErrorBody).error.code).toBe(
      "invalid_request",
    );
    expect(duplicate.body).not.toContain("scrypt");

    const counts = await context.pool.query<{ count: number }>(
      "select count(*)::int as count from operators",
    );
    expect(counts.rows[0].count).toBe(1);
    const createdAudits = await context.pool.query<{ count: number }>(
      [
        "select count(*)::int as count from audit_events",
        " where action = $1",
      ].join("\n"),
      [AUDIT_ACTIONS.operatorCreated],
    );
    expect(createdAudits.rows[0].count).toBe(1);

    // Zu kurzes Passwort: generischer 400 ohne Echo des Geheimnisses.
    const shortPassword = await app.inject({
      method: "POST",
      url: "/v1/admin/operators",
      headers: adminHeaders(adminCookie, { "content-type": "application/json" }),
      payload: { username: "syn-cx057-short", password: "kurz" },
      remoteAddress: "192.0.2.23",
    });
    expect(shortPassword.statusCode).toBe(400);
    expect((shortPassword.json() as LoginErrorBody).error.code).toBe(
      "invalid_request",
    );
    expect(shortPassword.body).not.toContain("kurz");

    // Geschlossenes DTO: actor_id/role sind keine Eingabefelder.
    const manipulated = await app.inject({
      method: "POST",
      url: "/v1/admin/operators",
      headers: adminHeaders(adminCookie, { "content-type": "application/json" }),
      payload: {
        username: "syn-cx057-manip",
        password: OPERATOR_PASSWORD,
        actor_id: "00000000-0000-4000-8000-000000000000",
        role: "Admin",
      },
      remoteAddress: "192.0.2.24",
    });
    expect(manipulated.statusCode).toBe(400);
    expect((manipulated.json() as LoginErrorBody).error.code).toBe(
      "invalid_request",
    );
    expect(manipulated.body).not.toContain(OPERATOR_PASSWORD);

    const after = await context.pool.query<{ count: number }>(
      "select count(*)::int as count from operators",
    );
    expect(after.rows[0].count).toBe(1);
  });
});

describe("CX-057 Integrationsgruppe 2: benannte Anmeldung", () => {
  it("meldet einen Operator ueber die normalisierte Kennung an, legt eine Operator-Sitzung an und gewaehrt nur Operatorrechte", async () => {
    const app = await context.buildApp();
    const adminCookie = await adminLogin(app);
    const operator = await createOperator(app, adminCookie, "syn-cx057-login");

    const login = await loginNamed(app, "SYN-CX057-LOGIN");
    expect(login.statusCode).toBe(204);
    const token = sessionTokenOf(login);
    expect(token.length).toBeGreaterThan(0);

    const session = await context.pool.query<{
      actor_id: string | null;
      token_hash: Buffer;
    }>(
      "select actor_id::text as actor_id, token_hash from admin_sessions where token_hash = $1",
      [hashToken(token)],
    );
    expect(session.rowCount).toBe(1);
    expect(session.rows[0].actor_id).toBe(operator.operator_id);
    expect(session.rows[0].token_hash.equals(hashToken(token))).toBe(true);

    const allowed = await app.inject({
      method: "GET",
      url: "/v1/admin/devices",
      headers: adminHeaders(token),
      remoteAddress: "192.0.2.31",
    });
    expect(allowed.statusCode).toBe(200);

    const denied = await app.inject({
      method: "POST",
      url: "/v1/admin/operators",
      headers: adminHeaders(token, { "content-type": "application/json" }),
      payload: { username: "syn-cx057-escalate", password: OPERATOR_PASSWORD },
      remoteAddress: "192.0.2.32",
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as LoginErrorBody).error.code).toBe("forbidden");

    const audits = await context.pool.query<{
      actor_id: string | null;
      details: Record<string, unknown>;
    }>(
      [
        "select actor_id, details from audit_events",
        " where action = $1 and actor_id = $2",
      ].join("\n"),
      [AUDIT_ACTIONS.adminLoginSucceeded, operator.operator_id],
    );
    expect(audits.rowCount).toBe(1);
    expect(audits.rows[0].details.role).toBe("Operator");
    const auditJson = JSON.stringify(audits.rows[0].details);
    expect(auditJson).not.toContain(OPERATOR_PASSWORD);
    expect(auditJson).not.toContain("scrypt");
  });

  it("liefert fuer falsches Passwort und unbekannte Kennung denselben generischen Fehler ohne Sitzung", async () => {
    const app = await context.buildApp();
    const adminCookie = await adminLogin(app);
    await createOperator(app, adminCookie, "syn-cx057-generic");

    const wrongPassword = await loginNamed(
      app,
      "syn-cx057-generic",
      OPERATOR_PASSWORD + "-falsch",
      "192.0.2.101",
    );
    expect(wrongPassword.statusCode).toBe(401);
    const wrongBody = wrongPassword.json() as LoginErrorBody;
    expect(wrongBody.error.code).toBe("unauthorized");
    expect(wrongBody.error.message).toBe("Nicht autorisiert.");
    expect(wrongPassword.headers["set-cookie"]).toBeUndefined();
    expect(wrongPassword.body).not.toContain(OPERATOR_PASSWORD);
    expect(wrongPassword.body).not.toContain("syn-cx057-generic");

    const unknown = await loginNamed(
      app,
      "syn-cx057-unbekannt",
      OPERATOR_PASSWORD,
      "192.0.2.102",
    );
    expect(unknown.statusCode).toBe(401);
    const unknownBody = unknown.json() as LoginErrorBody;
    expect(unknownBody.error.code).toBe(wrongBody.error.code);
    expect(unknownBody.error.message).toBe(wrongBody.error.message);
    expect(unknown.headers["set-cookie"]).toBeUndefined();
    expect(unknown.body).not.toContain("syn-cx057-unbekannt");

    // Es entsteht keine Operator-Sitzung; die Admin-Sitzung bleibt NULL.
    const sessions = await context.pool.query<{ count: number }>(
      "select count(*)::int as count from admin_sessions where actor_id is not null",
    );
    expect(sessions.rows[0].count).toBe(0);

    // Formatfehler bleiben Eingabefehler und keine Anmeldeaussage.
    const malformed = await loginNamed(
      app,
      "ab",
      OPERATOR_PASSWORD,
      "192.0.2.103",
    );
    expect(malformed.statusCode).toBe(400);
    expect((malformed.json() as LoginErrorBody).error.code).toBe(
      "invalid_request",
    );
  });
});

describe("CX-057 Integrationsgruppe 3: Sperrwirkung auf bestehende Sitzungen", () => {
  it("entwertet die bestehende Operatorsitzung sofort, macht die Wiederholung wirkungslos und schreibt genau ein Sperraudit", async () => {
    const app = await context.buildApp();
    const adminCookie = await adminLogin(app);
    const operator = await createOperator(app, adminCookie, "syn-cx057-lock");

    const login = await loginNamed(app, "syn-cx057-lock");
    expect(login.statusCode).toBe(204);
    const operatorCookie = sessionTokenOf(login);

    const before = await app.inject({
      method: "GET",
      url: "/v1/admin/devices",
      headers: adminHeaders(operatorCookie),
      remoteAddress: "192.0.2.201",
    });
    expect(before.statusCode).toBe(200);

    // Manipuliertes Token bleibt ungueltig.
    const tampered =
      operatorCookie.slice(0, -1) +
      (operatorCookie.endsWith("A") ? "B" : "A");
    const tamperedResponse = await app.inject({
      method: "GET",
      url: "/v1/admin/devices",
      headers: adminHeaders(tampered),
      remoteAddress: "192.0.2.202",
    });
    expect(tamperedResponse.statusCode).toBe(401);

    const disabled = await disableOperator(app, adminCookie, operator.operator_id);
    expect(disabled.statusCode).toBe(204);

    const after = await app.inject({
      method: "GET",
      url: "/v1/admin/devices",
      headers: adminHeaders(operatorCookie),
      remoteAddress: "192.0.2.203",
    });
    expect(after.statusCode).toBe(401);
    expect((after.json() as LoginErrorBody).error.code).toBe("unauthorized");

    // Die Sitzungszeile bleibt bestehen; die Sperrwirkung kommt aus dem Status.
    const session = await context.pool.query<{ count: number }>(
      [
        "select count(*)::int as count from admin_sessions",
        " where actor_id = $1::uuid",
      ].join("\n"),
      [operator.operator_id],
    );
    expect(session.rows[0].count).toBe(1);

    const state = await context.pool.query<{
      status: string;
      disabled_at: Date | null;
    }>(
      "select status, disabled_at from operators where actor_id = $1::uuid",
      [operator.operator_id],
    );
    expect(state.rows[0].status).toBe("disabled");
    expect(state.rows[0].disabled_at).not.toBeNull();

    const relogin = await loginNamed(
      app,
      "syn-cx057-lock",
      OPERATOR_PASSWORD,
      "192.0.2.204",
    );
    expect(relogin.statusCode).toBe(401);
    expect(relogin.headers["set-cookie"]).toBeUndefined();

    const wrongPassword = await loginNamed(
      app,
      "syn-cx057-lock",
      OPERATOR_PASSWORD + "-falsch",
      "192.0.2.205",
    );
    expect(wrongPassword.statusCode).toBe(401);
    expect((relogin.json() as LoginErrorBody).error.message).toBe(
      (wrongPassword.json() as LoginErrorBody).error.message,
    );

    // Wiederholung: 409 und kein zweiter Audit-Eintrag.
    const repeated = await disableOperator(
      app,
      adminCookie,
      operator.operator_id,
    );
    expect(repeated.statusCode).toBe(409);
    expect((repeated.json() as LoginErrorBody).error.code).toBe(
      "invalid_request",
    );
    const audits = await context.pool.query<{ count: number }>(
      [
        "select count(*)::int as count from audit_events",
        " where action = $1 and target_id = $2",
      ].join("\n"),
      [AUDIT_ACTIONS.operatorDisabled, operator.operator_id],
    );
    expect(audits.rows[0].count).toBe(1);

    // Der Admin bleibt handlungsfaehig.
    const adminStillAllowed = await app.inject({
      method: "GET",
      url: "/v1/admin/devices",
      headers: adminHeaders(adminCookie),
      remoteAddress: "192.0.2.206",
    });
    expect(adminStillAllowed.statusCode).toBe(200);
  });
});

describe("CX-057 Integrationsgruppe 4: Audit-Rollback und Migration", () => {
  it("rollt Anlage und Sperre bei erzwungenem Auditfehler vollstaendig zurueck", async () => {
    const app = await context.buildApp();
    const adminCookie = await adminLogin(app);

    await installAuditFailureTrigger(context.pool);
    try {
      const failedCreate = await app.inject({
        method: "POST",
        url: "/v1/admin/operators",
        headers: adminHeaders(adminCookie, {
          "content-type": "application/json",
        }),
        payload: {
          username: "syn-cx057-auditfail",
          password: OPERATOR_PASSWORD,
        },
        remoteAddress: "192.0.2.401",
      });
      expect(failedCreate.statusCode).toBe(500);
      expect((failedCreate.json() as LoginErrorBody).error.code).toBe(
        "internal_error",
      );
      expect(failedCreate.body).not.toContain("CX057 audit failure");
      expect(failedCreate.body).not.toContain("audit_events");
      expect(failedCreate.body).not.toContain(OPERATOR_PASSWORD);
    } finally {
      await dropAuditFailureTrigger(context.pool);
    }

    const failedRows = await context.pool.query<{ count: number }>(
      "select count(*)::int as count from operators",
    );
    expect(failedRows.rows[0].count).toBe(0);
    const failedAudits = await context.pool.query<{ count: number }>(
      [
        "select count(*)::int as count from audit_events",
        " where action = $1",
      ].join("\n"),
      [AUDIT_ACTIONS.operatorCreated],
    );
    expect(failedAudits.rows[0].count).toBe(0);

    // Erfolgreiche Anlage als Ausgangspunkt fuer die Sperre.
    const operator = await createOperator(app, adminCookie, "syn-cx057-audit");

    await installAuditFailureTrigger(context.pool);
    try {
      const failedDisable = await disableOperator(
        app,
        adminCookie,
        operator.operator_id,
      );
      expect(failedDisable.statusCode).toBe(500);
      expect((failedDisable.json() as LoginErrorBody).error.code).toBe(
        "internal_error",
      );
      expect(failedDisable.body).not.toContain("CX057 audit failure");
    } finally {
      await dropAuditFailureTrigger(context.pool);
    }

    const unchanged = await context.pool.query<{ status: string }>(
      "select status from operators where actor_id = $1::uuid",
      [operator.operator_id],
    );
    expect(unchanged.rows[0].status).toBe("active");
    const failedDisableAudits = await context.pool.query<{ count: number }>(
      [
        "select count(*)::int as count from audit_events",
        " where action = $1 and target_id = $2",
      ].join("\n"),
      [AUDIT_ACTIONS.operatorDisabled, operator.operator_id],
    );
    expect(failedDisableAudits.rows[0].count).toBe(0);

    const first = await disableOperator(app, adminCookie, operator.operator_id);
    expect(first.statusCode).toBe(204);
    const repeated = await disableOperator(
      app,
      adminCookie,
      operator.operator_id,
    );
    expect(repeated.statusCode).toBe(409);
    const audits = await context.pool.query<{ count: number }>(
      [
        "select count(*)::int as count from audit_events",
        " where action = $1 and target_id = $2",
      ].join("\n"),
      [AUDIT_ACTIONS.operatorDisabled, operator.operator_id],
    );
    expect(audits.rows[0].count).toBe(1);
  });

  it("loescht beim Rollback alle Operator-Sitzungen, sodass aktive und gesperrte Operator-Tokens nicht als Admin gelten", async () => {
    const rollbackContext = await createOperatorTestContext();
    try {
      const app = await rollbackContext.buildApp();
      const adminCookie = await adminLogin(app, "192.0.2.501");

      const activeOperator = await createOperator(
        app,
        adminCookie,
        "syn-cx057-rb-active",
      );
      const activeLogin = await loginNamed(
        app,
        "syn-cx057-rb-active",
        OPERATOR_PASSWORD,
        "192.0.2.502",
      );
      expect(activeLogin.statusCode).toBe(204);
      const activeToken = sessionTokenOf(activeLogin);

      const disabledOperator = await createOperator(
        app,
        adminCookie,
        "syn-cx057-rb-disabled",
      );
      const disabledLogin = await loginNamed(
        app,
        "syn-cx057-rb-disabled",
        OPERATOR_PASSWORD,
        "192.0.2.503",
      );
      expect(disabledLogin.statusCode).toBe(204);
      const disabledToken = sessionTokenOf(disabledLogin);
      const disable = await disableOperator(
        app,
        adminCookie,
        disabledOperator.operator_id,
      );
      expect(disable.statusCode).toBe(204);

      const service = new AdminAuthService({
        pool: rollbackContext.pool,
        config: rollbackContext.config,
        now: () => new Date(BASE_TIME),
      });

      // Vor dem Rollback: aktive Sitzung ist Operator, gesperrte ungueltig.
      const activeBefore = await service.verifySession(activeToken);
      expect(activeBefore?.role).toBe("Operator");
      expect(activeBefore?.actorId).toBe(activeOperator.operator_id);
      expect(await service.verifySession(disabledToken)).toBeNull();
      const adminBefore = await service.verifySession(adminCookie);
      expect(adminBefore?.role).toBe("Admin");
      expect(adminBefore?.actorId).toBe(LEGACY_ADMIN_ACTOR_ID);

      // Beide Operator-Tokens besitzen vor dem Rollback eine Sitzungszeile.
      for (const token of [activeToken, disabledToken]) {
        const rows = await rollbackContext.pool.query<{ count: number }>(
          "select count(*)::int as count from admin_sessions where token_hash = $1",
          [hashToken(token)],
        );
        expect(rows.rows[0].count).toBe(1);
      }

      const downSql = await readFile(
        join(
          process.cwd(),
          "src/db/migrations/0015_cx_057_operators.down.sql",
        ),
        "utf8",
      );
      await rollbackContext.pool.query(downSql);

      const actorColumn = await rollbackContext.pool.query(
        [
          "select 1 from information_schema.columns",
          " where table_schema = 'public'",
          "   and table_name = 'admin_sessions'",
          "   and column_name = 'actor_id'",
        ].join("\n"),
      );
      expect(actorColumn.rowCount).toBe(0);
      const operatorsTable = await rollbackContext.pool.query(
        [
          "select 1 from information_schema.tables",
          " where table_schema = 'public'",
          "   and table_name = 'operators'",
        ].join("\n"),
      );
      expect(operatorsTable.rowCount).toBe(0);

      // Regression: ohne Loeschung wuerden diese Tokens als Legacy-Admin gelten.
      expect(await service.verifySession(activeToken)).toBeNull();
      expect(await service.verifySession(disabledToken)).toBeNull();
      for (const token of [activeToken, disabledToken]) {
        const rows = await rollbackContext.pool.query<{ count: number }>(
          "select count(*)::int as count from admin_sessions where token_hash = $1",
          [hashToken(token)],
        );
        expect(rows.rows[0].count).toBe(0);
      }

      // Die bestehende Legacy-Admin-Sitzung bleibt gueltig.
      const adminAfter = await service.verifySession(adminCookie);
      expect(adminAfter?.role).toBe("Admin");
      expect(adminAfter?.actorId).toBe(LEGACY_ADMIN_ACTOR_ID);
      const adminRows = await rollbackContext.pool.query<{ count: number }>(
        "select count(*)::int as count from admin_sessions where token_hash = $1",
        [hashToken(adminCookie)],
      );
      expect(adminRows.rows[0].count).toBe(1);
    } finally {
      await rollbackContext.close();
    }
  }, 180_000);
});
