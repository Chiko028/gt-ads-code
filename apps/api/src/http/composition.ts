/**
 * CX-033: einziger Registrierungspunkt der vorhandenen CX-031/CX-032
 * HTTP-Plugins.
 *
 * Der Punkt registriert ausschliesslich die tatsaechlich vorhandenen Plugins:
 * den Upload-Adapter (CX-031 / R-202) und den Kundenkern (CX-032 / R-204).
 * Es gibt keine automatische Modul-Discovery und keine vorsorgliche
 * Instanziierung HTTP-loser Servicekerne (Kampagnen, Backup, Alarme usw.).
 *
 * Der gemeinsame Fehlerbaustein wird in einem eigenen Fastify-Kontext
 * installiert. Dadurch gilt er genau fuer diese Routen; globale Hooks und
 * bestehende lokale Vertragsfehlerhandler bleiben unveraendert. Der Kontext
 * wird pro App-Instanz neu aufgebaut; es gibt keinen modulweiten
 * Registrierungszustand.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AdminAuthService } from "../modules/adminAuth/service.js";
import { CustomerService } from "../modules/campaigns/customers.js";
import { registerCustomerRoutes } from "../modules/campaigns/routes.js";
import { installContractErrorHandling } from "./jsonContract.js";
import {
  registerMediaUploadRoute,
  type MediaUploadDeps,
} from "./mediaUpload.js";

export interface HttpCompositionDeps {
  pool: Pool;
  adminAuth: AdminAuthService;
  mediaUpload: MediaUploadDeps;
}

export function registerHttpComposition(
  app: FastifyInstance,
  deps: HttpCompositionDeps,
): void {
  void app.register(async (scope) => {
    // Gekapselter Fehlerbaustein fuer den neuen Pluginbereich.
    installContractErrorHandling(scope);

    // CX-031: Upload-Adapter, genau einmal.
    registerMediaUploadRoute(scope, deps.mediaUpload);

    // CX-032: Kundenkern-Basisendpunkte, genau einmal. Der Service wird pro
    // App-Instanz neu erzeugt und teilt keinen veraenderlichen Zustand.
    const customerService = new CustomerService({ pool: deps.pool });
    registerCustomerRoutes(scope, {
      service: customerService,
      adminAuth: deps.adminAuth,
    });
  });
}
