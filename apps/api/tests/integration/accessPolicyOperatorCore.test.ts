import Fastify, { type FastifyInstance, type HTTPMethods } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { hasAction, listCatalogKeys } from "../../src/http/accessPolicy.js";
import { installAccessControl } from "../../src/http/authorization.js";
import { registerErrorHandler } from "../../src/http/errors.js";
import type { Principal } from "../../src/http/principal.js";

const HOST = "127.0.0.1:8080";

const OPERATOR_ALLOWED: ReadonlyArray<{ method: HTTPMethods; url: string }> = [
  { method: "GET", url: "/v1/admin/devices" },
  { method: "GET", url: "/v1/admin/media" },
  { method: "PATCH", url: "/v1/admin/media/:id" },
  { method: "GET", url: "/v1/admin/campaigns" },
  { method: "PATCH", url: "/v1/admin/campaigns/:id" },
  { method: "POST", url: "/v1/admin/taxis/:id/pause" },
  { method: "POST", url: "/v1/admin/taxis/:id/resume" },
];

const ADMIN_ONLY: ReadonlyArray<{ method: HTTPMethods; url: string }> = [
  { method: "GET", url: "/v1/admin/registration-codes" },
  { method: "POST", url: "/v1/admin/registration-codes" },
  { method: "DELETE", url: "/v1/admin/registration-codes/:id" },
  { method: "POST", url: "/v1/admin/devices/:id/revoke" },
  { method: "GET", url: "/v1/admin/audit-events" },
  { method: "POST", url: "/v1/admin/security/sessions/revoke" },
  { method: "POST", url: "/v1/admin/operators" },
  { method: "POST", url: "/v1/admin/operators/:operatorId/disable" },
  { method: "PUT", url: "/v1/admin/taxis/:id/config" },
  { method: "PATCH", url: "/v1/admin/taxis/:id/config" },
];

const ROUTES = [...OPERATOR_ALLOWED, ...ADMIN_ONLY];

interface CoreApp {
  app: FastifyInstance;
  hits: string[];
}

const openApps: FastifyInstance[] = [];

/**
 * Kleine Fastify-App mit dem produktiven Rechte-Plugin und einem injizierten
 * serverseitigen Test-Identitaetsresolver. Die Handler sind bewusst neutral:
 * sie belegen nur, ob der Rechtekern den Fachhandler erreicht.
 */
async function buildCoreApp(principal: unknown): Promise<CoreApp> {
  const app = Fastify({ logger: false });
  // Vorhandene Fehlerkonvention der API (error.code im Body).
  registerErrorHandler(app);
  const hits: string[] = [];
  installAccessControl(app, {
    resolvePrincipal: async () => principal as Principal | null,
  });

  for (const route of ROUTES) {
    const label = String(route.method) + " " + route.url;
    app.route({
      method: route.method,
      url: route.url,
      handler: async (_request, reply) => {
        hits.push(label);
        reply.code(200).send({ ok: true });
      },
    });
  }

  await app.ready();
  openApps.push(app);
  return { app, hits };
}

afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await app.close();
  }
});

function call(
  app: FastifyInstance,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
): Promise<{ statusCode: number; json: () => any }> {
  return app.inject({ method, url, headers: { host: HOST } });
}

describe("CX-015 Rechtekern: Operatorrechte am produktiven Plugin", () => {
  it("erlaubt Operator fachliche Listen, Medien-/Kampagnenbearbeitung und Pause/Fortsetzen, verweigert Enrollment, Geraetesperren, Audit, Sicherheit und Konfiguration und gewaehrt Admin weiterhin alle Verwaltungsrechte", async () => {
    const operator = await buildCoreApp({ id: "SYN-operator", role: "Operator" });

    for (const route of OPERATOR_ALLOWED) {
      const response = await call(operator.app, route.method as "GET", route.url);
      expect(
        response.statusCode,
        "Operator muss " + route.method + " " + route.url + " erreichen",
      ).toBe(200);
      expect(operator.hits).toContain(String(route.method) + " " + route.url);
    }

    for (const route of ADMIN_ONLY) {
      const response = await call(operator.app, route.method as "GET", route.url);
      expect(
        response.statusCode,
        "Operator darf " + route.method + " " + route.url + " nicht erreichen",
      ).toBe(403);
      expect(response.json().error.code).toBe("forbidden");
      expect(operator.hits).not.toContain(String(route.method) + " " + route.url);
    }

    // Genau zwei Rollen; unbekannte Rollen und Aktionen gewaehren keine Rechte.
    expect(hasAction("Operator", "audit.read")).toBe(false);
    expect(hasAction("Operator", "config.write")).toBe(false);
    expect(hasAction("Operator", "security.manage")).toBe(false);
    expect(hasAction("Operator", "operators.manage")).toBe(false);
    expect(hasAction("Operator", "registrationCodes.manage")).toBe(false);
    expect(hasAction("Operator", "devices.revoke")).toBe(false);
    expect(hasAction("Unbekannt", "devices.read")).toBe(false);
    expect(hasAction("Admin", "config.write")).toBe(true);
    expect(listCatalogKeys()).toContain("PATCH /v1/admin/media/:id");

    // Admin behaelt saemtliche Verwaltungsrechte.
    const admin = await buildCoreApp({ id: "SYN-admin", role: "Admin" });
    for (const route of ADMIN_ONLY) {
      const response = await call(admin.app, route.method as "GET", route.url);
      expect(
        response.statusCode,
        "Admin muss " + route.method + " " + route.url + " erreichen",
      ).toBe(200);
    }

    // Eine unbekannte Rolle ist keine gueltige Identitaet: 401, kein Handler.
    const unknown = await buildCoreApp({ id: "SYN-unbekannt", role: "Superuser" });
    const denied = await call(unknown.app, "GET", "/v1/admin/devices");
    expect(denied.statusCode).toBe(401);
    expect(unknown.hits).toHaveLength(0);

    // Auch ein fehlender Principal bleibt 401.
    const anonymous = await buildCoreApp(null);
    const anonymousDenied = await call(anonymous.app, "GET", "/v1/admin/devices");
    expect(anonymousDenied.statusCode).toBe(401);
    expect(anonymous.hits).toHaveLength(0);
  });
});
