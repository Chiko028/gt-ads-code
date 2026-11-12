import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, type AppConfig } from "../../../src/config.js";
import {
  createServer,
  type ApiServerOptions,
} from "../../../src/http/server.js";
import { createOperationsMetrics } from "../../../src/modules/operations/metrics.js";
import type {
  ReadinessProbe,
  TimerScheduler,
} from "../../../src/modules/operations/readiness.js";

const config: AppConfig = {
  ...CONFIG_DEFAULTS,
  env: "test",
  databaseUrl: "",
  registrationCodePepper: "SYN-CX018-Code-Pepper",
  adminPasswordHash:
    "scrypt$N=16384,r=8,p=1$c3ludGhldGlzY2hlLXNhbHQ$aGFzaC1oYXNoLWhhc2gtaGFzaC1oYXNo",
};

const openApps: FastifyInstance[] = [];

function rowCountPool(): Pool {
  return {
    query: async () => ({ rowCount: 0 }),
    connect: async () => {
      throw new Error("connect darf hier nicht verwendet werden");
    },
    end: async () => undefined,
  } as unknown as Pool;
}

function brokenPool(): Pool {
  return {
    query: async () => {
      throw new Error("postgres://user:secret@db.internal:5432/gt_ads");
    },
    connect: async () => {
      throw new Error("postgres://user:secret@db.internal:5432/gt_ads");
    },
    end: async () => undefined,
  } as unknown as Pool;
}

async function buildApp(
  overrides: Partial<ApiServerOptions> = {},
): Promise<FastifyInstance> {
  const app = createServer({
    config,
    pool: rowCountPool(),
    ...overrides,
  });
  await app.ready();
  openApps.push(app);
  return app;
}

afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await app.close();
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Bedingung wurde nicht rechtzeitig erfuellt");
}

interface ManualTimer {
  id: number;
  delayMs: number;
  callback: () => void;
}

interface ManualScheduler extends TimerScheduler {
  tasks: ManualTimer[];
}

function manualScheduler(): ManualScheduler {
  const tasks: ManualTimer[] = [];
  let nextId = 1;
  return {
    tasks,
    setTimeout(callback: () => void, delayMs: number): unknown {
      const id = nextId;
      nextId += 1;
      tasks.push({ id, delayMs, callback });
      return id;
    },
    clearTimeout(handle: unknown): void {
      const index = tasks.findIndex((task) => task.id === handle);
      if (index >= 0) {
        tasks.splice(index, 1);
      }
    },
  };
}

describe("interne Betriebsschnittstellen", () => {
  it("GET /health bleibt bei ausgefallener Datenbank unveraendert", async () => {
    const app = await buildApp({ pool: brokenPool() });

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({
      status: "ok",
      env: "test",
      version: "0.1.0",
    });

    const ready = await app.inject({ method: "GET", url: "/internal/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: "not_ready" });
    expect(ready.payload).not.toContain("secret");
    expect(ready.payload).not.toContain("postgres");
    expect(ready.payload).not.toContain("db.internal");
  });

  it("GET /internal/ready liefert 200 und aktualisiert die Readiness", async () => {
    let calls = 0;
    const readiness: ReadinessProbe = {
      async check(): Promise<void> {
        calls += 1;
      },
    };
    const metrics = createOperationsMetrics();
    const app = await buildApp({ operations: { readiness, metrics } });

    const response = await app.inject({
      method: "GET",
      url: "/internal/ready",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
    expect(response.headers["content-type"]).toContain("application/json");
    expect(calls).toBe(1);

    const scraped = await app.inject({
      method: "GET",
      url: "/internal/metrics",
    });
    expect(scraped.body).toContain("gt_ads_readiness 1");
  });

  it("GET /internal/ready liefert bei Fehler 503 ohne Verbindungsdaten", async () => {
    const readiness: ReadinessProbe = {
      async check(): Promise<void> {
        throw new Error(
          "postgres://user:secret@db.internal:5432/gt_ads?ssl=true",
        );
      },
    };
    const metrics = createOperationsMetrics();
    const app = await buildApp({ operations: { readiness, metrics } });

    const response = await app.inject({
      method: "GET",
      url: "/internal/ready",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
    for (const fragment of [
      "postgres",
      "secret",
      "db.internal",
      "5432",
      "ssl=true",
    ]) {
      expect(response.payload).not.toContain(fragment);
    }
    expect(metrics.render()).toContain("gt_ads_readiness 0");
  });

  it("GET /internal/ready liefert bei Ablauf von 1000 ms 503", async () => {
    const scheduler = manualScheduler();
    const readiness: ReadinessProbe = {
      check: () => new Promise<void>(() => undefined),
    };
    const app = await buildApp({
      operations: {
        readiness,
        metrics: createOperationsMetrics(),
        readinessTimeoutMs: 1000,
        scheduler,
      },
    });

    const pending = app.inject({
      method: "GET",
      url: "/internal/ready",
    });
    await waitFor(() => scheduler.tasks.length === 1);
    expect(scheduler.tasks[0]?.delayMs).toBe(1000);
    scheduler.tasks[0]?.callback();

    const response = await pending;
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
    expect(scheduler.tasks).toHaveLength(0);
  });

  it("weist nicht lokale Peeradressen auch mit gefaelschten Headern ab", async () => {
    let calls = 0;
    const readiness: ReadinessProbe = {
      async check(): Promise<void> {
        calls += 1;
      },
    };
    const app = await buildApp({ operations: { readiness } });

    for (const headers of [
      { "x-forwarded-for": "127.0.0.1" },
      { forwarded: "for=127.0.0.1;proto=http;host=localhost" },
      { "x-real-ip": "::1", "x-forwarded-for": "127.0.0.1, 127.0.0.1" },
    ]) {
      const response = await app.inject({
        method: "GET",
        url: "/internal/ready",
        remoteAddress: "192.0.2.44",
        headers,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("forbidden");
    }
    expect(calls).toBe(0);

    const localWithForwarded = await app.inject({
      method: "GET",
      url: "/internal/ready",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(localWithForwarded.statusCode).toBe(200);

    const ipv6 = await app.inject({
      method: "GET",
      url: "/internal/ready",
      remoteAddress: "::1",
    });
    expect(ipv6.statusCode).toBe(200);
  });

  it("GET /internal/metrics nutzt nur feste Labels und leakt keine Anfragewerte", async () => {
    const readiness: ReadinessProbe = {
      async check(): Promise<void> {
        return undefined;
      },
    };
    const metrics = createOperationsMetrics();
    const app = await buildApp({ operations: { readiness, metrics } });

    await app.inject({ method: "GET", url: "/health" });
    await app.inject({
      method: "GET",
      url: "/v1/secret/DEV-ONE?token=TOPSECRET&device_id=DEV-ONE",
    });
    await app.inject({
      method: "GET",
      url: "/v1/other/DEV-TWO?token=OTHER",
    });
    await app.inject({
      method: "POST",
      url: "/v1/unknown?token=THIRD",
    });
    await app.inject({
      method: "GET",
      url: "/v1/admin/devices/DEV-SECRET-42?token=TOPSECRET",
    });

    const before = await app.inject({
      method: "GET",
      url: "/internal/metrics?probe=SECRET",
    });
    const body = before.body;

    expect(body).toContain(
      'gt_ads_http_requests_total{method="GET",route="/health",status_class="2xx"} 1',
    );
    expect(body).toContain(
      'gt_ads_http_requests_total{method="GET",route="unmatched",status_class="4xx"} 2',
    );
    expect(body).toContain(
      'gt_ads_http_requests_total{method="POST",route="unmatched",status_class="4xx"} 1',
    );
    expect(body).toContain(
      'gt_ads_http_requests_total{method="GET",route="/v1/admin/devices/:id",status_class="4xx"} 1',
    );

    for (const fragment of [
      "TOPSECRET",
      "DEV-ONE",
      "DEV-TWO",
      "OTHER",
      "THIRD",
      "SECRET",
      "DEV-SECRET-42",
      "/v1/secret",
      "/v1/other",
      "/v1/unknown",
      'route="/internal/metrics"',
      'route="/internal/ready"',
    ]) {
      expect(body).not.toContain(fragment);
    }

    expect(body).toContain("gt_ads_readiness NaN");

    const labels = [...body.matchAll(/route="([^"]*)"/g)].map(
      (match) => match[1],
    );
    expect(new Set(labels)).toEqual(
      new Set(["/health", "unmatched", "/v1/admin/devices/:id"]),
    );

    const methods = [...body.matchAll(/method="([^"]*)"/g)].map(
      (match) => match[1],
    );
    expect(new Set(methods)).toEqual(new Set(["GET", "POST"]));

    const second = await app.inject({
      method: "GET",
      url: "/internal/metrics",
    });
    expect(second.body).toContain(
      'gt_ads_http_requests_total{method="GET",route="/health",status_class="2xx"} 1',
    );
    expect(second.body).not.toContain('route="/internal/metrics"');
  });
});
