/**
 * CX-051 / R-406: authentifizierte CSV-Route fuer den Kundenbericht.
 *
 * Registriert genau GET /v1/admin/reports/customer.csv. Authentifizierung und
 * Autorisierung erfolgen ueber die vorhandene Verwaltungs-Sitzung (CX-015)
 * und die explizite Lesepolitik im Rechtekern; es gibt keine oeffentliche
 * Kundenroute, keinen Versand und keine Browser-Exportfunktion.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { ApiError } from "./errors.js";
import { createAdminSessionMiddleware } from "../modules/adminAuth/middleware.js";
import type { AdminAuthService } from "../modules/adminAuth/service.js";
import {
  CustomerReportRowLimitError,
  StatisticsRowLimitError,
  createCustomerReportService,
  parseCustomerReportQuery,
  serializeCustomerReportCsv,
} from "../modules/statistics/index.js";

/** Einzige registrierte Route dieses Arbeitspakets. */
export const CUSTOMER_REPORT_PATH = "/v1/admin/reports/customer.csv";

/** Fester, sicherer Dateiname; enthaelt keine Anfragewerte. */
export const CUSTOMER_REPORT_FILENAME = "customer-report.csv";

export interface CustomerReportRouteDeps {
  pool: Pool;
  adminAuth: AdminAuthService;
  /** Injizierbare Serveruhr; ohne Angabe gilt die reale Uhr. */
  now?: () => Date;
}

export function registerCustomerReportRoute(
  app: FastifyInstance,
  deps: CustomerReportRouteDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);
  const service = createCustomerReportService({
    pool: deps.pool,
    now: deps.now,
  });

  app.route({
    method: "GET",
    url: CUSTOMER_REPORT_PATH,
    onRequest: [sessionGuard],
    handler: async (request, reply) => {
      if (request.accessPrincipal === undefined) {
        throw ApiError.unauthorized();
      }
      const query = parseCustomerReportQuery(request.query);

      let rows;
      try {
        rows = await service.buildReport(query, request.accessPrincipal.id);
      } catch (error) {
        if (
          error instanceof CustomerReportRowLimitError ||
          error instanceof StatisticsRowLimitError
        ) {
          // Ausdrueckliche Ablehnung statt abgeschnittener CSV-Datei.
          throw ApiError.invalidRequest();
        }
        throw error;
      }

      reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header(
          "Content-Disposition",
          'attachment; filename="' + CUSTOMER_REPORT_FILENAME + '"',
        )
        .header("Cache-Control", "no-store")
        .send(serializeCustomerReportCsv(rows));
    },
  });
}
