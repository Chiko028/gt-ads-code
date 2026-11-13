/**
 * Fastify-Einbindung des zentralen Rechtekerns (CX-015 / R-601).
 *
 * installAccessControl() wird vor der Routenregistrierung auf der Wurzelinstanz
 * installiert und
 * 1. erfasst im onRoute-Hook jede registrierte Methode mit ihrem
 *    Routentemplate (auch automatisch erzeugte HEAD-Routen und Routen in
 *    gekapselten Kindkontexten),
 * 2. verweigert beim App-Start (onReady) den Start, sobald eine registrierte
 *    Route keine explizite Policy besitzt,
 * 3. erzwingt im onRequest-Hook Authentifizierung und Autorisierung
 *    menschlicher Routen vor jedem Fachhandler und vor der Bodyverarbeitung.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  findRoutePolicy,
  hasAction,
  type RoutePolicy,
} from "./accessPolicy.js";
import { ApiError } from "./errors.js";
import { isValidPrincipal, type Principal, type PrincipalResolver } from "./principal.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Vom Rechtekern gesetzter, serverseitig aufgeloester Principal. */
    accessPrincipal?: Principal;
  }
}

export interface AccessControlOptions {
  /**
   * Serverseitiger Principal-Resolver. Im normalen App-Aufbau ausschliesslich
   * der Sitzungsresolver; Tests duerfen einen Resolver injizieren.
   */
  resolvePrincipal: PrincipalResolver;
}

export interface RoutePolicyRecord {
  readonly method: string;
  readonly url: string;
  readonly policy: RoutePolicy | null;
}

const inventories = new WeakMap<FastifyInstance, RoutePolicyRecord[]>();

/**
 * Erfasste Routen inklusive Klassifikation. Nur fuer Startpruefung, Tests und
 * Diagnose; die Laufzeitpruefung fragt den Katalog direkt.
 */
export function getRoutePolicyInventory(
  app: FastifyInstance,
): readonly RoutePolicyRecord[] {
  return inventories.get(app) ?? [];
}

/** Schreibmethoden, fuer die der bestehende Origin-/CSRF-Schutz gilt. */
const WRITE_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase());
}

/**
 * Origin-Regel aus der vorhandenen Admin-Schreibpruefung
 * (modules/adminAuth/middleware.ts, API-VERTRAG.md Abschnitt 5): ein
 * gesendeter Origin-Header muss dem eigenen Ursprung entsprechen. Bewusst
 * ohne Content-Type-Pflicht, damit binaere Uploads mit vorhandenen erlaubten
 * Content-Types nicht an einer globalen JSON-Regel scheitern.
 */
function assertSameOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return;
  }
  const host = request.headers.host;
  if (typeof host !== "string" || host.length === 0) {
    throw ApiError.forbidden();
  }
  const expected = request.protocol + "://" + host;
  if (origin !== expected) {
    throw ApiError.forbidden();
  }
}

async function enforceHumanPolicy(
  request: FastifyRequest,
  options: AccessControlOptions,
  policy: RoutePolicy & { category: "human" },
): Promise<void> {
  if (isWriteMethod(request.method)) {
    assertSameOrigin(request);
  }

  const principal = await options.resolvePrincipal(request);
  if (!isValidPrincipal(principal)) {
    throw ApiError.unauthorized();
  }
  if (!hasAction(principal.role, policy.action)) {
    throw ApiError.forbidden();
  }
  request.accessPrincipal = principal;
}

export function installAccessControl(
  app: FastifyInstance,
  options: AccessControlOptions,
): void {
  const records: RoutePolicyRecord[] = [];
  inventories.set(app, records);

  app.addHook("onRoute", (routeOptions) => {
    const declared = routeOptions.method;
    const methods = Array.isArray(declared) ? declared : [declared];
    for (const method of methods) {
      const upper = method.toUpperCase();
      records.push({
        method: upper,
        url: routeOptions.url,
        policy: findRoutePolicy(upper, routeOptions.url) ?? null,
      });
    }
  });

  app.addHook("onReady", async () => {
    const unclassified = records
      .filter((record) => record.policy === null)
      .map((record) => record.method + " " + record.url);
    if (unclassified.length > 0) {
      throw new Error(
        "Rechtekern: unklassifizierte Route(n) ohne Policy: " +
          unclassified.join(", "),
      );
    }
  });

  app.addHook("onRequest", async (request) => {
    const policy = findRoutePolicy(
      request.method,
      request.routeOptions.url,
    );
    // Kein Treffer bedeutet keine registrierte Route (z. B. 404); die
    // Startpruefung stellt sicher, dass registrierte Routen klassifiziert sind.
    if (policy === undefined || policy.category !== "human") {
      return;
    }
    await enforceHumanPolicy(request, options, policy);
  });
}
