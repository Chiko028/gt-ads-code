/**
 * Serverseitiger Principal-Adapter des Rechtekerns (CX-015 / R-601).
 *
 * Ein Principal ist ausschliesslich das Ergebnis einer serverseitigen
 * Identitaetspruefung. Cookies, Header, Requestfelder oder Geraeteidentitaeten
 * werden niemals ungeprueft als menschliche Rolle uebernommen.
 */
import type { FastifyRequest } from "fastify";
import { isRole, type Role } from "./accessPolicy.js";
import { ADMIN_SESSION_COOKIE } from "../modules/adminAuth/middleware.js";
import {
  LEGACY_ADMIN_ACTOR_ID,
  type AdminAuthService,
} from "../modules/adminAuth/service.js";

/**
 * Feste interne Identitaet des bisherigen gemeinsamen Administratorkontos.
 * Sie behauptet keine individuelle Personenzuordnung; die bestehende
 * Produktionsanmeldung kennt nur diese eine Verwaltungsidentitaet.
 */
export const LEGACY_ADMIN_PRINCIPAL_ID = LEGACY_ADMIN_ACTOR_ID;

export interface Principal {
  readonly id: string;
  readonly role: Role;
}

/**
 * Loest die menschliche Identitaet einer Anfrage auf. Der Resolver ist die
 * einzige Stelle, an der eine Rolle entsteht; in Tests wird er injiziert, im
 * normalen App-Aufbau ist ausschliesslich der Sitzungsresolver aktiv.
 */
export type PrincipalResolver = (
  request: FastifyRequest,
) => Promise<Principal | null>;

function readAdminSessionToken(request: FastifyRequest): string | undefined {
  const cookies = request.cookies as
    | Record<string, string | undefined>
    | undefined;
  if (cookies === undefined) {
    return undefined;
  }
  const token = cookies[ADMIN_SESSION_COOKIE];
  return typeof token === "string" ? token : undefined;
}

/**
 * Produktionsresolver: nutzt ausschliesslich die vorhandene serverseitige
 * Sitzungspruefung (Ablauf, Logout und Operatorstatus inklusive). Die Rolle
 * stammt aus der Sitzung selbst; Operator-Sitzungen werden bei jeder Anfrage
 * erneut gegen den persistierten Aktivstatus geprueft.
 */
export function createLegacyAdminPrincipalResolver(
  service: AdminAuthService,
): PrincipalResolver {
  return async function resolveLegacyAdminPrincipal(
    request: FastifyRequest,
  ): Promise<Principal | null> {
    const token = readAdminSessionToken(request);
    if (token === undefined || token.length === 0) {
      return null;
    }
    const session = await service.verifySession(token);
    if (session === null) {
      return null;
    }
    return { id: session.actorId, role: session.role };
  };
}

/**
 * Prueft das Ergebnis eines Resolvers zur Laufzeit. Unbekannte Rollen oder
 * fehlerhafte Objekte gelten als nicht authentifiziert und gewaehren keine
 * Rechte (kein Vertrauen in injizierte Testresolver).
 */
export function isValidPrincipal(value: unknown): value is Principal {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { id?: unknown; role?: unknown };
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    isRole(candidate.role)
  );
}
