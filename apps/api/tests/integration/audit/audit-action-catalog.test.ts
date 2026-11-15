import type { FastifyInstance } from "fastify";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { getRoutePolicyInventory } from "../../../src/http/authorization.js";
import {
  AUDIT_ACTIONS,
  AUDIT_WRITE_ROUTE_ACTIONS,
  AUDIT_WRITE_ROUTE_EXEMPTIONS,
  auditActionForWriteRoute,
} from "../../../src/modules/audit/repository.js";
import {
  adminHeaders,
  createAuditTestContext,
  type AuditTestContext,
} from "./support.js";

const WRITE_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const OPERATOR_PASSWORD = "SYN-CX058-Operator-Passwort";

interface HumanWriteRoute {
  readonly method: string;
  readonly url: string;
  readonly key: string;
}

function humanWriteRoutes(app: FastifyInstance): HumanWriteRoute[] {
  return getRoutePolicyInventory(app)
    .filter(
      (record) =>
        WRITE_METHODS.has(record.method) &&
        record.policy?.category === "human",
    )
    .map((record) => ({
      method: record.method,
      url: record.url,
      key: record.method + " " + record.url,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

interface AuditRow {
  actor_type: string;
  actor_id: string | null;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
}

type CatalogCase =
  | {
      readonly name: string;
      readonly kind: "route";
      readonly routeKey: string;
      readonly action: string;
    }
  | { readonly name: string; readonly kind: "coverage" }
  | { readonly name: string; readonly kind: "operator-create" }
  | { readonly name: string; readonly kind: "operator-disable" };

const CASES: readonly CatalogCase[] = [
  ...Object.entries(AUDIT_WRITE_ROUTE_ACTIONS).map(([routeKey, action]) => ({
    name: "Katalogzuordnung: " + routeKey,
    kind: "route" as const,
    routeKey,
    action,
  })),
  {
    name: "Inventar: jede menschliche Schreibrouten-Vorlage ist zugeordnet",
    kind: "coverage" as const,
  },
  {
    name: "Operator-Anlage erzeugt genau einen Aenderungserfolg",
    kind: "operator-create" as const,
  },
  {
    name: "Operator-Sperre erzeugt genau einen Aenderungserfolg",
    kind: "operator-disable" as const,
  },
];

let context: AuditTestContext;
let app: FastifyInstance;

beforeAll(async () => {
  context = await createAuditTestContext();
  app = await context.buildApp("Admin");
}, 120_000);

beforeEach(async () => {
  await context.pool.query(
    "truncate table audit_events, admin_sessions, operators restart identity cascade",
  );
});

afterAll(async () => {
  await context.close();
}, 30_000);

function requestIdOf(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["x-request-id"];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("X-Request-Id fehlt");
  }
  return raw;
}

async function createOperator(
  targetApp: FastifyInstance,
  cookie: string,
  username: string,
) {
  return targetApp.inject({
    method: "POST",
    url: "/v1/admin/operators",
    headers: adminHeaders(cookie, { "content-type": "application/json" }),
    payload: { username, password: OPERATOR_PASSWORD },
    remoteAddress: "192.0.2.231",
  });
}

async function auditRowsFor(
  action: string,
  targetId: string,
): Promise<AuditRow[]> {
  const result = await context.pool.query<AuditRow>(
    [
      "select actor_type, actor_id, target_type, target_id, details",
      "  from audit_events",
      " where action = $1 and target_id = $2",
      " order by id asc",
    ].join("\n"),
    [action, targetId],
  );
  return result.rows;
}

describe("CX-058 Audit-Abdeckung der Verwaltungs-Schreibrouten", () => {
  it.each(CASES)("$name", async (testCase) => {
    if (testCase.kind === "route") {
      const actual = humanWriteRoutes(app);
      const match = actual.find((route) => route.key === testCase.routeKey);
      expect(
        match,
        "Route ist nicht als menschliche Schreibroute registriert: " +
          testCase.routeKey,
      ).toBeDefined();
      if (match === undefined) {
        throw new Error(
          "Route ist nicht als menschliche Schreibroute registriert: " +
            testCase.routeKey,
        );
      }
      expect(
        auditActionForWriteRoute(match.method, match.url),
        "Audit-Aktion fuer " + testCase.routeKey,
      ).toBe(testCase.action);
      return;
    }

    if (testCase.kind === "coverage") {
      const actualKeys = humanWriteRoutes(app)
        .map((route) => route.key)
        .filter((key) => !AUDIT_WRITE_ROUTE_EXEMPTIONS.has(key))
        .sort();
      expect(actualKeys).toEqual(Object.keys(AUDIT_WRITE_ROUTE_ACTIONS).sort());
      for (const key of actualKeys) {
        const [method] = key.split(" ");
        const url = key.slice((method ?? "").length + 1);
        expect(auditActionForWriteRoute(method ?? "", url)).toBeTypeOf(
          "string",
        );
      }
      return;
    }

    const cookie = await context.loginCookie(app);

    if (testCase.kind === "operator-create") {
      const response = await createOperator(
        app,
        cookie,
        "syn-cx058-created",
      );
      expect(response.statusCode).toBe(201);
      const body = response.json() as { operator_id: string };
      const rows = await auditRowsFor(
        AUDIT_ACTIONS.operatorCreated,
        body.operator_id,
      );
      expect(rows).toHaveLength(1);
      const row = rows[0] as AuditRow;
      expect(row.actor_type).toBe("admin");
      expect(row.actor_id).toBe("SYN-CX058-Admin");
      expect(row.target_type).toBe("operator");
      expect(row.target_id).toBe(body.operator_id);
      expect(row.details.request_id).toBe(requestIdOf(response));
      return;
    }

    const created = await createOperator(
      app,
      cookie,
      "syn-cx058-disabled",
    );
    expect(created.statusCode).toBe(201);
    const operatorId = (created.json() as { operator_id: string }).operator_id;

    const disabled = await app.inject({
      method: "POST",
      url: "/v1/admin/operators/" + operatorId + "/disable",
      headers: adminHeaders(cookie, { "content-type": "application/json" }),
      payload: {},
      remoteAddress: "192.0.2.232",
    });
    expect(disabled.statusCode).toBe(204);

    const rows = await auditRowsFor(
      AUDIT_ACTIONS.operatorDisabled,
      operatorId,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0] as AuditRow;
    expect(row.actor_type).toBe("admin");
    expect(row.actor_id).toBe("SYN-CX058-Admin");
    expect(row.target_type).toBe("operator");
    expect(row.target_id).toBe(operatorId);
    expect(row.details.request_id).toBe(requestIdOf(disabled));
  });
});
