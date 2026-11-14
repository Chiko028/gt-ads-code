/**
 * Zentraler Rechtekern (CX-015 / R-601).
 *
 * Der Katalog ordnet jeder tatsaechlich registrierten Route eine explizite
 * Zugriffspolitik zu. Schluessel sind HTTP-Methode und Routentemplate
 * (z. B. "GET /v1/admin/devices/:id"), niemals konkrete Request-URLs und
 * niemals Pfadpraefixe: eine neue Route ist ohne Katalogeintrag nicht
 * startfaehig (siehe authorization.ts).
 *
 * Kategorien:
 * - "human": menschliche Verwaltung mit expliziter Aktion; Authentifizierung
 *   und Autorisierung erfolgen vor dem Fachhandler und vor der Bodyverarbeitung.
 * - "public": oeffentliche Route, deren bestehende Validierung (Rate-Limit,
 *   Passwortpruefung, Header-/Formatpruefung, Loopback-Bindung) unveraendert
 *   gilt. Der Rechtekern fuegt keine Authentifizierung hinzu.
 * - "device": Geraeteauthentifizierung; der vorhandene Bearer-/Challenge-
 *   Nachweis der Route bleibt allein massgeblich.
 * - "signed-download": signierter Download; der vorhandene Nachweis der Route
 *   bleibt allein massgeblich.
 *
 * Es gibt genau die Rollen Admin und Operator. Unbekannte Rollen und
 * unbekannte Aktionen gewaehren keine Rechte.
 */

/** Rollen des Rechtekerns. */
export const ROLES = ["Admin", "Operator"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Explizite Aktionen menschlicher Verwaltung. Die Namen sind fachlich
 * geschnitten, nicht routenbezogen; mehrere Routen duerfen dieselbe Aktion
 * tragen (z. B. Pause und Fortsetzen).
 */
export type AccessAction =
  | "session.logout"
  | "devices.read"
  | "devices.inventory"
  | "devices.revoke"
  | "registrationCodes.manage"
  | "media.read"
  | "media.write"
  | "campaigns.read"
  | "campaigns.write"
  | "taxi.pause"
  | "taxi.activation"
  | "tablet.activation"
  | "audit.read"
  | "security.manage"
  | "config.read"
  | "config.write"
  | "groups.write"
  | "groups.read";

export type RoutePolicy =
  | { readonly category: "human"; readonly action: AccessAction }
  | { readonly category: "public" }
  | { readonly category: "device" }
  | { readonly category: "signed-download" };

function human(action: AccessAction): RoutePolicy {
  return { category: "human", action };
}

const PUBLIC: RoutePolicy = { category: "public" };
const DEVICE: RoutePolicy = { category: "device" };
const SIGNED_DOWNLOAD: RoutePolicy = { category: "signed-download" };

/** Schluessel eines Katalogeintrags: Methode und Routentemplate. */
export function routePolicyKey(method: string, template: string): string {
  return method.toUpperCase() + " " + template;
}

/**
 * Katalog der vorhandenen Routen (apps/api/src/http/server.ts und die dort
 * eingebundenen Module) sowie reservierter Templates der noch nicht
 * registrierten Fachmodule. Reservierte Eintraege klassifizieren keine
 * laufende Route; sie legen nur die Rechte fest, die beim Registrieren der
 * Fachroute gelten. Neue Fachrouten aus CX-033/CX-056 muessen ihren Eintrag
 * hier ergaenzen, sonst verweigert der Start.
 */
const POLICY_CATALOG: Readonly<Record<string, RoutePolicy>> = Object.freeze({
  // Betrieb und oeffentliche Geraeteschnittstellen.
  "GET /health": PUBLIC,
  "POST /v1/device/register": PUBLIC,
  "POST /v1/admin/login": PUBLIC,
  "GET /internal/ready": PUBLIC,
  "GET /internal/metrics": PUBLIC,
  "POST /v1/device/auth/challenge": DEVICE,
  "POST /v1/device/auth/token": DEVICE,
  "POST /v1/device/heartbeat": DEVICE,
  "POST /v1/device/events": DEVICE,
  "GET /v1/device/downloads/:id": SIGNED_DOWNLOAD,
  "GET /v1/device/manifest": DEVICE,

  // Menschliche Verwaltung: Sitzung.
  "POST /v1/admin/logout": human("session.logout"),

  // Menschliche Verwaltung: Geraete.
  "GET /v1/admin/devices": human("devices.read"),
  "GET /v1/admin/devices/:id": human("devices.read"),
  "POST /v1/admin/devices/:id/revoke": human("devices.revoke"),

  // Inventarliste (CX-129 / R-106): ausschliesslich lesend unter devices.read.
  "GET /v1/admin/inventory": human("devices.read"),
  "PATCH /v1/admin/inventory/:tabletId": human("devices.inventory"),

  // Menschliche Verwaltung: Registrierungscodes.
  "GET /v1/admin/registration-codes": human("registrationCodes.manage"),
  "POST /v1/admin/registration-codes": human("registrationCodes.manage"),
  "DELETE /v1/admin/registration-codes/:id": human("registrationCodes.manage"),

  // Medien (CX-031 Upload, CX-033 Liste), Kampagnen (CX-056), Pause/Fortsetzen.
  "GET /v1/admin/media": human("media.read"),
  "POST /v1/admin/media": human("media.write"),
  "PATCH /v1/admin/media/:id": human("media.write"),
  "GET /v1/admin/campaigns": human("campaigns.read"),
  "PATCH /v1/admin/campaigns/:id": human("campaigns.write"),
  "POST /v1/admin/campaigns": human("campaigns.write"),
  "GET /v1/admin/taxi-groups": human("groups.read"),
  "POST /v1/admin/taxi-groups": human("groups.write"),
  "GET /v1/admin/campaigns/:id": human("campaigns.read"),

  // Kundenkern (CX-032): Basisendpunkte unter derselben Fachaktion.
  "GET /v1/admin/customers": human("campaigns.read"),
  "POST /v1/admin/customers": human("campaigns.write"),
  "GET /v1/admin/customers/:id": human("campaigns.read"),
  "POST /v1/admin/taxis/:id/pause": human("taxi.pause"),
  "POST /v1/admin/taxis/:id/resume": human("taxi.pause"),
  // CX-052 / R-501: dieselbe fachliche Aktion fuer die tatsaechlich
  // registrierten Templates mit benanntem Taxi-Parameter.
  "POST /v1/admin/taxis/:taxi_id/pause": human("taxi.pause"),
  "POST /v1/admin/taxis/:taxi_id/resume": human("taxi.pause"),
  "POST /v1/admin/taxis/:taxiId/activation": human("taxi.activation"),
  "PATCH /v1/admin/tablets/:tabletId/activation": human("tablet.activation"),

  // Reserviert: ausschliesslich Admin.
  "GET /v1/admin/audit": human("audit.read"),
  "GET /v1/admin/audit-events": human("audit.read"),
  "POST /v1/admin/security/sessions/revoke": human("security.manage"),
  "PUT /v1/admin/taxis/:id/config": human("config.write"),
  "PATCH /v1/admin/taxis/:id/config": human("config.write"),
  "GET /v1/admin/taxis/:taxiId/config": human("config.read"),
  "GET /v1/admin/taxis/:taxiId/playout-preview": human("config.read"),
  "PATCH /v1/admin/taxis/:taxiId/config": human("config.write"),
});

/**
 * Rechte je Rolle. Admin behaelt die bestehenden Verwaltungsrechte vollstaendig.
 * Operator erhaelt fachliche Leseaktionen, Medien-/Kampagnenbearbeitung sowie
 * Pause/Fortsetzen. Registrierungscodeverwaltung, Geraetesperren, Audit-Lesen,
 * Sicherheitsverwaltung und versionierte Konfigurationsaenderungen bleiben
 * Admin vorbehalten.
 */
const ALL_ACTIONS: readonly AccessAction[] = [
  "session.logout",
  "devices.read",
  "devices.inventory",
  "devices.revoke",
  "registrationCodes.manage",
  "media.read",
  "media.write",
  "campaigns.read",
  "campaigns.write",
  "taxi.pause",
  "taxi.activation",
  "tablet.activation",
  "audit.read",
  "security.manage",
  "config.read",
  "config.write",
  "groups.write",
  "groups.read",
];

const ROLE_ACTIONS: Readonly<Record<Role, ReadonlySet<AccessAction>>> = Object.freeze({
  Admin: new Set<AccessAction>(ALL_ACTIONS),
  Operator: new Set<AccessAction>([
    "session.logout",
    "devices.read",
    "devices.inventory",
    "media.read",
    "media.write",
    "campaigns.read",
    "campaigns.write",
    "taxi.pause",
    "taxi.activation",
    "tablet.activation",
    "config.read",
    "groups.read",
  ]),
});

/**
 * Policy einer registrierten Route. Automatisch erzeugte HEAD-Routen erben die
 * Policy der gleichnamigen GET-Route; sie werden dadurch ohne eigenen
 * Katalogeintrag explizit klassifiziert.
 */
export function findRoutePolicy(
  method: string,
  template: string | undefined,
): RoutePolicy | undefined {
  if (template === undefined || template.length === 0) {
    return undefined;
  }
  const normalized = method.toUpperCase();
  const direct = POLICY_CATALOG[routePolicyKey(normalized, template)];
  if (direct !== undefined) {
    return direct;
  }
  if (normalized === "HEAD") {
    return POLICY_CATALOG[routePolicyKey("GET", template)];
  }
  return undefined;
}

export function isRole(value: unknown): value is Role {
  return value === "Admin" || value === "Operator";
}

/** Unbekannte Rollen erhalten keine Rechte. */
export function hasAction(role: string, action: AccessAction): boolean {
  if (!isRole(role)) {
    return false;
  }
  const granted = ROLE_ACTIONS[role];
  return granted !== undefined && granted.has(action);
}

/** Nur fuer Tests und Diagnose: alle Katalogschluessel. */
export function listCatalogKeys(): readonly string[] {
  return Object.keys(POLICY_CATALOG).sort();
}
