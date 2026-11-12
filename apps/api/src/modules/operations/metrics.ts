/**
 * Begrenzte In-Prozess-Metriken fuer die interne Betriebsschnittstelle.
 *
 * Kardinalitaet: Labels stammen ausschliesslich aus der von Fastify
 * aufgeloesten Routenvorlage, einer festen Methodenliste und einer festen
 * Statusklasse. Unbekannte Routen werden zu genau einem festen Label
 * zusammengefasst; Anfrage-URLs, Queryparameter, Tokens oder Geraete-IDs
 * gelangen nicht in die Metriken.
 */

export type ReadinessState = "unknown" | "ready" | "not_ready";

export interface RequestMetricInput {
  /** HTTP-Methode der Anfrage; unbekannte Methoden werden zu OTHER. */
  method: string;
  /** Registrierte Routenvorlage (request.routeOptions.url) oder null. */
  route: string | null | undefined;
  statusCode: number;
  durationSeconds: number;
}

export interface OperationsMetrics {
  observeRequest(input: RequestMetricInput): void;
  setReadiness(state: ReadinessState): void;
  render(): string;
}

/** Festes Label fuer nicht aufgeloeste Routen (404/405). */
export const UNMATCHED_ROUTE = "unmatched";

const KNOWN_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE",
  "CONNECT",
]);

interface RequestSeries {
  method: string;
  route: string;
  statusClass: string;
  count: number;
  durationSeconds: number;
}

function methodLabel(method: string): string {
  const normalized = method.trim().toUpperCase();
  return KNOWN_METHODS.has(normalized) ? normalized : "OTHER";
}

function statusClass(statusCode: number): string {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    return "unknown";
  }
  return String(Math.floor(statusCode / 100)) + "xx";
}

function routeLabel(route: string | null | undefined): string {
  // Routenvorlagen sind Pfade ohne Query/Fragment. Alles andere wird nicht
  // als Label uebernommen, damit keine Anfragewerte in die Exposition gelangen.
  if (
    typeof route !== "string" ||
    !route.startsWith("/") ||
    route.includes("?") ||
    route.includes("#") ||
    route.includes("\n") ||
    route.includes("\r")
  ) {
    return UNMATCHED_ROUTE;
  }
  return route;
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}

class InProcessOperationsMetrics implements OperationsMetrics {
  private readonly series = new Map<string, RequestSeries>();
  private readiness: ReadinessState = "unknown";

  observeRequest(input: RequestMetricInput): void {
    const method = methodLabel(input.method);
    const route = routeLabel(input.route);
    const cls = statusClass(input.statusCode);
    const key = method + "\u0000" + route + "\u0000" + cls;

    const existing = this.series.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      existing.durationSeconds += Math.max(0, input.durationSeconds);
      return;
    }

    this.series.set(key, {
      method,
      route,
      statusClass: cls,
      count: 1,
      durationSeconds: Math.max(0, input.durationSeconds),
    });
  }

  setReadiness(state: ReadinessState): void {
    this.readiness = state;
  }

  render(): string {
    const lines: string[] = [];
    lines.push(
      "# HELP gt_ads_http_requests_total Anzahl der HTTP-Anfragen.",
    );
    lines.push("# TYPE gt_ads_http_requests_total counter");

    const ordered = [...this.series.values()].sort((a, b) => {
      return (
        a.method.localeCompare(b.method) ||
        a.route.localeCompare(b.route) ||
        a.statusClass.localeCompare(b.statusClass)
      );
    });

    for (const series of ordered) {
      const labels =
        'method="' +
        escapeLabelValue(series.method) +
        '",route="' +
        escapeLabelValue(series.route) +
        '",status_class="' +
        escapeLabelValue(series.statusClass) +
        '"';
      lines.push(
        "gt_ads_http_requests_total{" + labels + "} " + formatNumber(series.count),
      );
    }

    lines.push(
      "# HELP gt_ads_http_request_duration_seconds Summierte HTTP-Anfragedauer in Sekunden.",
    );
    lines.push("# TYPE gt_ads_http_request_duration_seconds counter");
    for (const series of ordered) {
      const labels =
        'method="' +
        escapeLabelValue(series.method) +
        '",route="' +
        escapeLabelValue(series.route) +
        '",status_class="' +
        escapeLabelValue(series.statusClass) +
        '"';
      lines.push(
        "gt_ads_http_request_duration_seconds{" +
          labels +
          "} " +
          formatNumber(series.durationSeconds),
      );
    }

    lines.push(
      "# HELP gt_ads_readiness Letzte Readiness-Pruefung: 1=ready, 0=not_ready, NaN=unknown/unbekannt.",
    );
    lines.push("# TYPE gt_ads_readiness gauge");
    const readinessValue =
      this.readiness === "ready"
        ? "1"
        : this.readiness === "not_ready"
          ? "0"
          : "NaN";
    lines.push("gt_ads_readiness " + readinessValue);

    return lines.join("\n") + "\n";
  }
}

export function createOperationsMetrics(): OperationsMetrics {
  return new InProcessOperationsMetrics();
}
