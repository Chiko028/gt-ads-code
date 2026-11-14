export const DASHBOARD_ROUTE_IDS = [
  "geraete",
  "taxis",
  "medien",
  "kampagnen",
  "ausspielung",
  "status",
  "bedienung",
  "benutzer",
  "betrieb",
] as const;

export type DashboardRouteId = (typeof DASHBOARD_ROUTE_IDS)[number];

export interface DashboardRoute {
  readonly id: DashboardRouteId;
  readonly hash: string;
  readonly label: string;
}

/**
 * Einzige Quelle fuer Navigationsziele, Hash und sichtbare Beschriftung.
 * Neue Ziele werden hier ergaenzt; die Reihenfolge ist die Navigationsreihenfolge.
 */
export const DASHBOARD_ROUTES: readonly DashboardRoute[] = [
  { id: "geraete", hash: "#/geraete", label: "Geräte" },
  { id: "taxis", hash: "#/taxis", label: "Taxis" },
  { id: "medien", hash: "#/medien", label: "Medien" },
  { id: "kampagnen", hash: "#/kampagnen", label: "Kampagnen" },
  { id: "ausspielung", hash: "#/ausspielung", label: "Ausspielung" },
  { id: "status", hash: "#/status", label: "Status" },
  { id: "bedienung", hash: "#/bedienung", label: "Bedienung" },
  { id: "benutzer", hash: "#/benutzer", label: "Benutzer" },
  { id: "betrieb", hash: "#/betrieb", label: "Betrieb" },
] as const;

export const DEFAULT_ROUTE_ID: DashboardRouteId = "geraete";

const ROUTE_BY_HASH = new Map<string, DashboardRoute>(
  DASHBOARD_ROUTES.map((route) => [route.hash, route]),
);

export type RouteMatch =
  | { readonly kind: "route"; readonly route: DashboardRoute }
  | { readonly kind: "not_found" };

/**
 * Leerer Hash (auch "#" und "#/") fuehrt zum Standardziel Geraete.
 * Jede andere unbekannte Adresse ist ausdruecklich nicht gefunden und
 * wird nie stillschweigend auf ein anderes Ziel umgebogen.
 */
export function matchHash(hash: string): RouteMatch {
  const raw = hash.trim();
  if (raw === "" || raw === "#" || raw === "#/") {
    const fallback = DASHBOARD_ROUTES.find(
      (route) => route.id === DEFAULT_ROUTE_ID,
    );
    if (fallback === undefined) {
      throw new Error("Standard-Navigationsziel fehlt.");
    }
    return { kind: "route", route: fallback };
  }
  const route = ROUTE_BY_HASH.get(raw);
  if (route === undefined) {
    return { kind: "not_found" };
  }
  return { kind: "route", route };
}

export function routeById(id: DashboardRouteId): DashboardRoute {
  const route = DASHBOARD_ROUTES.find((item) => item.id === id);
  if (route === undefined) {
    throw new Error("Unbekanntes Navigationsziel: " + id);
  }
  return route;
}
