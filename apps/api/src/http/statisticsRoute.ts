/**
 * CX-049 / R-404: authentifizierte, lesende Statistikroute.
 *
 * Registriert genau GET /v1/admin/statistics. Die Route nutzt die vorhandene
 * Verwaltungs-Sitzung (CX-015) und den gemeinsamen JSON-Vertragsbaustein
 * (CX-033). Es gibt keinen Schreibpfad und keine zweite Authentifizierung.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { ApiError } from "./errors.js";
import { registerJsonRoute } from "./jsonContract.js";
import { createAdminSessionMiddleware } from "../modules/adminAuth/middleware.js";
import type { AdminAuthService } from "../modules/adminAuth/service.js";
import {
  StatisticsRowLimitError,
  createStatisticsService,
} from "../modules/statistics/service.js";
import { parseStatisticsQuery } from "../modules/statistics/validation.js";
import type { StatisticsResponse } from "../modules/statistics/types.js";

/** Einzige registrierte Route dieses Arbeitspakets. */
export const STATISTICS_PATH = "/v1/admin/statistics";

export interface StatisticsRouteDeps {
  pool: Pool;
  adminAuth: AdminAuthService;
  /** Injizierbare Serveruhr; ohne Angabe gilt die reale Uhr. */
  now?: () => Date;
}

export function registerStatisticsRoute(
  app: FastifyInstance,
  deps: StatisticsRouteDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);
  const service = createStatisticsService({
    pool: deps.pool,
    now: deps.now,
  });

  registerJsonRoute(app, {
    method: "GET",
    url: STATISTICS_PATH,
    onRequest: [sessionGuard],
    handler: async (request, reply) => {
      if (request.accessPrincipal === undefined) {
        throw ApiError.unauthorized();
      }
      const query = parseStatisticsQuery(request.query);
      let body: StatisticsResponse;
      try {
        body = await service.getStatistics(query);
      } catch (error) {
        if (error instanceof StatisticsRowLimitError) {
          // Ausdrueckliche Ablehnung statt stiller Kuerzung.
          throw ApiError.invalidRequest();
        }
        throw error;
      }
      reply.header("Cache-Control", "no-store");
      reply.code(200).send(body);
    },
  });
}

