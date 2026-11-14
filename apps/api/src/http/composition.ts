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
import {
  registerTaxiGroupCreateRoute,
  registerTaxiGroupListRoute,
} from "./taxiGroupRoutes.js";
import {
  registerDeviceEventRoutes,
  type DeviceEventIngest,
} from "./deviceEvents.js";
import { registerPlayoutPreviewRoute } from "./playoutPreview.js";
import { registerTaxiActivationRoute } from "./taxiActivationRoutes.js";
import { TaxiActivationService } from "../modules/taxiActivation/index.js";
import { registerTabletActivationRoute } from "./tabletActivationRoutes.js";
import { TabletActivationService } from "../modules/tabletActivation/index.js";
import { registerInventoryListRoute } from "./inventoryList.js";
import { registerInventoryWriteRoute } from "./inventoryWrite.js";
import { DeviceInventoryService } from "../modules/inventory/service.js";

export interface HttpCompositionDeps {
  pool: Pool;
  adminAuth: AdminAuthService;
  deviceAuth: DeviceAuthService;
  mediaUpload: MediaUploadDeps;
  mediaList: MediaListDeps;
  /** CX-046: vorhandener CX-009-Kern als schmale Speichergrenze. */
  telemetryIngest: DeviceEventIngest;
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

    // CX-116 / R-104: geschuetzte Gruppenliste desselben Bestands.
    registerTaxiGroupListRoute(scope, {
      pool: deps.pool,
      adminAuth: deps.adminAuth,
    });

    // CX-125 / R-104: geschuetzte Aktivierung/Deaktivierung. Der Adapter
    // delegiert genau einmal an CX-124; Audit entsteht nur dort.
    registerTaxiActivationRoute(scope, {
      service: new TaxiActivationService({ pool: deps.pool }),
      adminAuth: deps.adminAuth,
    });

    // CX-127 / R-104: geschuetzte Tablet-Aktivierung. Der Adapter delegiert
    // genau einmal an CX-126; Transaktion und Audit entstehen nur dort.
    registerTabletActivationRoute(scope, {
      service: new TabletActivationService({ pool: deps.pool }),
      adminAuth: deps.adminAuth,
    });

    // CX-129 / R-106: geschuetzte, paginierte Inventarliste. Der Adapter
    // liest Geraete per LEFT JOIN; es entsteht keine zweite Persistenz.
    registerInventoryListRoute(scope, {
      pool: deps.pool,
      adminAuth: deps.adminAuth,
    });

    // CX-130 / R-106: geschuetzte Inventaraenderung. Der Adapter delegiert
    // genau einmal an CX-128; Transaktion und Audit entstehen nur dort.
    registerInventoryWriteRoute(scope, {
      service: new DeviceInventoryService({ pool: deps.pool }),
      adminAuth: deps.adminAuth,
    });

    // CX-042 / R-302: authentifizierter Manifest-Abruf. Taxi und aktive
    // Tabletzuordnung kommen ausschliesslich aus dem serverseitigen
    // Leseadapter; die Route nimmt keine Taxi- oder Geraete-ID an.
    const manifestReader = createSqlDeviceManifestReader(deps.pool);
    const manifestService = createDeviceManifestService({
      reader: manifestReader,
    });
    registerDeviceManifestRoutes(scope, {
      service: manifestService,
      deviceAuth: deps.deviceAuth,
    });

    // CX-044 / R-304: lesende Ausspielungs-Vorschau. Sie nutzt denselben
    // veroeffentlichten Manifest-Lesezugriff und erzeugt nichts neu.
    registerPlayoutPreviewRoute(scope, {
      getCurrentArtifact: (taxiId) => manifestReader.getCurrentArtifact(taxiId),
      taxiExists: createSqlTaxiExists(deps.pool),
    });

    // CX-046 / R-401: authentifizierter, idempotenter Ereigniseingang.
    // Die Route delegiert unveraendert an den vorhandenen CX-009-Kern.
    registerDeviceEventRoutes(scope, {
      ingest: deps.telemetryIngest,
      deviceAuth: deps.deviceAuth,
    });
  });
}
