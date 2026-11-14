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
import type { DeviceAuthService } from "../modules/deviceAuth/service.js";
import {
  createDeviceManifestService,
  createSqlDeviceManifestReader,
  registerDeviceManifestRoutes,
} from "../modules/deviceManifest/index.js";
import { CustomerService } from "../modules/campaigns/customers.js";
import { CampaignService } from "../modules/campaigns/campaigns.js";
import { createControlConfigService } from "../modules/controlConfig/index.js";
import { registerCampaignRoutes } from "../modules/campaigns/campaignRoutes.js";
import { registerCustomerRoutes } from "../modules/campaigns/routes.js";
import { installContractErrorHandling } from "./jsonContract.js";
import {
  registerMediaUploadRoute,
  type MediaUploadDeps,
} from "./mediaUpload.js";
import {
  registerMediaListRoute,
  type MediaListDeps,
} from "./mediaList.js";
import {
  createSqlTaxiExists,
  registerTaxiConfigRoutes,
} from "./taxiConfigRoutes.js";
import { registerTaxiGroupCreateRoute } from "./taxiGroupRoutes.js";

export interface HttpCompositionDeps {
  pool: Pool;
  adminAuth: AdminAuthService;
  deviceAuth: DeviceAuthService;
  mediaUpload: MediaUploadDeps;
  mediaList: MediaListDeps;
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

    // CX-095 / R-203: geschuetzte, begrenzte Medienliste. Der Adapter nutzt
    // die vorhandene CX-030-Listengrenze; es entsteht keine zweite
    // Medienverwaltung.
    registerMediaListRoute(scope, deps.mediaList);

    // CX-032: Kundenkern-Basisendpunkte, genau einmal. Der Service wird pro
    // App-Instanz neu erzeugt und teilt keinen veraenderlichen Zustand.
    const customerService = new CustomerService({ pool: deps.pool });
    registerCustomerRoutes(scope, {
      service: customerService,
      adminAuth: deps.adminAuth,
    });

    // CX-038: Kampagnenrouten. Die einzige Kampagnenpersistenz stellt ihr
    // additives Schema beim ersten Kampagnenzugriff idempotent bereit.
    const campaignService = new CampaignService({ pool: deps.pool });
    registerCampaignRoutes(scope, {
      service: campaignService,
      adminAuth: deps.adminAuth,
    });

    // CX-053: versionierte Taxi-Konfiguration. Der Adapter verwendet den
    // vorhandenen CX-013-Service unveraendert; es gibt keine zweite
    // Konfigurationstabelle und keine eigene Fachlogik.
    const controlConfigService = createControlConfigService({ pool: deps.pool });
    registerTaxiConfigRoutes(scope, {
      service: controlConfigService,
      adminAuth: deps.adminAuth,
      taxiExists: createSqlTaxiExists(deps.pool),
    });

    // CX-115 / R-104: geschuetzte Anlage einer leeren Taxigruppe, genau
    // einmal in dieser Komposition registriert.
    registerTaxiGroupCreateRoute(scope, {
      pool: deps.pool,
      adminAuth: deps.adminAuth,
    });

    // CX-042 / R-302: authentifizierter Manifest-Abruf. Taxi und aktive
    // Tabletzuordnung kommen ausschliesslich aus dem serverseitigen
    // Leseadapter; die Route nimmt keine Taxi- oder Geraete-ID an.
    const manifestService = createDeviceManifestService({
      reader: createSqlDeviceManifestReader(deps.pool),
    });
    registerDeviceManifestRoutes(scope, {
      service: manifestService,
      deviceAuth: deps.deviceAuth,
    });
  });
}
