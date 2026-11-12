import { describe, expect, it } from "vitest";
import {
  createOperationsMetrics,
  UNMATCHED_ROUTE,
} from "../../../src/modules/operations/metrics.js";

function line(text: string, prefix: string): string | undefined {
  return text
    .split("\n")
    .find((candidate) => candidate.startsWith(prefix));
}

describe("operations metrics", () => {
  it("zaehlt Anfragen und summiert die Dauer je Routenvorlage", () => {
    const metrics = createOperationsMetrics();

    metrics.observeRequest({
      method: "GET",
      route: "/health",
      statusCode: 200,
      durationSeconds: 0.25,
    });
    metrics.observeRequest({
      method: "GET",
      route: "/health",
      statusCode: 200,
      durationSeconds: 0.75,
    });

    const text = metrics.render();
    expect(
      line(text, "gt_ads_http_requests_total{"),
    ).toContain(
      'method="GET",route="/health",status_class="2xx"} 2',
    );
    expect(
      line(text, "gt_ads_http_request_duration_seconds{"),
    ).toContain(
      'method="GET",route="/health",status_class="2xx"} 1',
    );
  });

  it("fasst unbekannte Routen und unbekannte Methoden fest zusammen", () => {
    const metrics = createOperationsMetrics();

    metrics.observeRequest({
      method: "GET",
      route: null,
      statusCode: 404,
      durationSeconds: 0.1,
    });
    metrics.observeRequest({
      method: "GET",
      route: "/v1/devices/DEV-GEHEIM?token=TOPSECRET",
      statusCode: 404,
      durationSeconds: 0.1,
    });
    metrics.observeRequest({
      method: "BRW",
      route: undefined,
      statusCode: 404,
      durationSeconds: 0.1,
    });

    const text = metrics.render();
    expect(text).not.toContain("TOPSECRET");
    expect(text).not.toContain("DEV-GEHEIM");

    const requestLines = text
      .split("\n")
      .filter((candidate) => candidate.startsWith("gt_ads_http_requests_total{"));
    expect(requestLines).toHaveLength(2);
    expect(requestLines.join("\n")).toContain(
      'method="GET",route="' + UNMATCHED_ROUTE + '",status_class="4xx"} 2',
    );
    expect(requestLines.join("\n")).toContain(
      'method="OTHER",route="' + UNMATCHED_ROUTE + '",status_class="4xx"} 1',
    );
  });

  it("normalisiert Statusklassen und escapet Labelwerte", () => {
    const metrics = createOperationsMetrics();

    metrics.observeRequest({
      method: "POST",
      route: '/v1/a"b',
      statusCode: 503,
      durationSeconds: 0,
    });
    metrics.observeRequest({
      method: "GET",
      route: "/v1/ok",
      statusCode: 302,
      durationSeconds: 0,
    });
    metrics.observeRequest({
      method: "GET",
      route: "/v1/gone",
      statusCode: 999,
      durationSeconds: 0,
    });

    const text = metrics.render();
    expect(text).toContain('route="/v1/a\\"b"');
    expect(text).toContain('status_class="5xx"} 1');
    expect(text).toContain('route="/v1/ok",status_class="3xx"} 1');
    expect(text).toContain('route="/v1/gone",status_class="unknown"} 1');
  });

  it("kennzeichnet Readiness vor der ersten Pruefung als unbekannt", () => {
    const metrics = createOperationsMetrics();
    expect(metrics.render()).toContain("gt_ads_readiness NaN");
    expect(metrics.render()).toContain("NaN=unknown/unbekannt");

    metrics.setReadiness("ready");
    expect(metrics.render()).toContain("gt_ads_readiness 1");

    metrics.setReadiness("not_ready");
    expect(metrics.render()).toContain("gt_ads_readiness 0");
  });
});
