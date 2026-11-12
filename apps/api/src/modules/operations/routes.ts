import type { FastifyInstance } from "fastify";
import { isIP } from "node:net";
import { ApiError } from "../../http/errors.js";
import type { OperationsMetrics } from "./metrics.js";
import {
  READINESS_TIMEOUT_MS,
  withDeadline,
  type ReadinessProbe,
  type TimerScheduler,
} from "./readiness.js";

export interface OperationsOverrides {
  readiness?: ReadinessProbe;
  metrics?: OperationsMetrics;
  readinessTimeoutMs?: number;
  scheduler?: TimerScheduler;
}

export interface OperationsRouteOptions extends OperationsOverrides {
  readiness: ReadinessProbe;
  metrics: OperationsMetrics;
}

/**
 * Nur die tatsaechliche Peeradresse zaehlt. X-Forwarded-For, Forwarded
 * oder X-Real-IP werden bewusst nicht ausgewertet (trustProxy bleibt aus).
 */
export function isLoopbackAddress(
  address: string | null | undefined,
): boolean {
  if (address === null || address === undefined) {
    return false;
  }
  const normalized = address.trim().toLowerCase();
  if (normalized === "::1") {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackAddress(normalized.slice("::ffff:".length));
  }
  if (isIP(normalized) !== 4) {
    return false;
  }
  return normalized.split(".")[0] === "127";
}

/**
 * Betriebsschnittstellen liegen ausserhalb von /v1 und werden nicht als
 * HTTP-Anfragen gezaehlt. Der Vergleich nutzt den Pfad ohne Query, damit
 * auch ein Queryparameter keine Rolle spielt.
 */
export function isOperationsUrl(
  rawUrl: string,
  routeTemplate?: string | null,
): boolean {
  const path = routeTemplate ?? rawUrl.split("?")[0];
  return path === "/internal" || path.startsWith("/internal/");
}

/**
 * Registriert GET /internal/ready und GET /internal/metrics. Beide Routen
 * sind nur ueber Loopback erreichbar und bewusst nicht Teil von /v1.
 */
export function registerOperationsRoutes(
  app: FastifyInstance,
  options: OperationsRouteOptions,
): void {
  void app.register(async (scope) => {
    scope.addHook("onRequest", async (request) => {
      if (!isLoopbackAddress(request.raw.socket.remoteAddress)) {
        throw ApiError.forbidden();
      }
    });

    scope.get("/internal/ready", async (_request, reply) => {
      try {
        await withDeadline(options.readiness.check(), {
          timeoutMs: options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS,
          scheduler: options.scheduler,
        });
        options.metrics.setReadiness("ready");
        return reply
          .code(200)
          .type("application/json; charset=utf-8")
          .send({ status: "ready" });
      } catch {
        // Keine Fehlermeldung, kein Verbindungsdetail nach aussen.
        options.metrics.setReadiness("not_ready");
        return reply
          .code(503)
          .type("application/json; charset=utf-8")
          .send({ status: "not_ready" });
      }
    });

    scope.get("/internal/metrics", async (_request, reply) => {
      return reply
        .code(200)
        .type("text/plain; version=0.0.4; charset=utf-8")
        .send(options.metrics.render());
    });
  });
}
