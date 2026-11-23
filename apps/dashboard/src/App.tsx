import type { ReactNode } from "react";

import { AdminShell, TotpSetupScreen } from "./admin/AdminShell";
import type { FetchLike } from "./admin/adminApi";
import { CampaignPage } from "./campaigns/CampaignPage";
import type { FleetTransport } from "./fleet/fleetApi";
import { FleetPage } from "./fleet/FleetPage";
import { MediaPage } from "./media/MediaPage";
import type { UploadTransport } from "./media/uploadTransport";
import { NavigationFrame } from "./navigation/NavigationFrame";
import { PageErrorBoundary } from "./navigation/PageErrorBoundary";
import type { DashboardRouteId } from "./navigation/routes";
import type { OperationsClient } from "./operations/operationsApi";
import { OperationsPage } from "./operations/OperationsPage";
import { AppUpdatesPanel } from "./operations/AppUpdatesPanel";
import { PlayoutPreviewPage } from "./playout/PlayoutPreviewPage";
import type { StatisticsClient } from "./statistics/statisticsApi";
import { StatisticsPage } from "./statistics/StatisticsPage";

export interface AppProps {
  /** Injizierbares fetch fuer Shell, Client und Tests. */
  readonly fetchImpl?: FetchLike;
  /**
   * Injizierbarer Upload-Transport fuer die Medienseite (CX-039). Ohne
   * Angabe wird der vorhandene XHR-Transport verwendet.
   */
  readonly uploadTransport?: UploadTransport;
  /**
   * Injizierbarer Transport fuer die Taxi-/Gruppen-/Inventarseite (CX-037).
   * Ohne Angabe wird der vorhandene same-origin-fetch verwendet.
   */
  readonly fleetTransport?: FleetTransport;
  /**
   * Injizierbarer Statistikclient (CX-050). Ohne Angabe wird der vorhandene
   * Fetch-Client mit derselben Cookie-Sitzung verwendet.
   */
  readonly statisticsClient?: StatisticsClient;
  /**
   * Injizierbarer lesender Betriebsclient (CX-062/R-703). Ohne Angabe wird
   * der vorhandene Fetch-Client mit derselben Cookie-Sitzung verwendet.
   */
  readonly operationsClient?: OperationsClient;
}

export { PageErrorBoundary } from "./navigation/PageErrorBoundary";
export type { PageErrorBoundaryProps } from "./navigation/PageErrorBoundary";

function guardedPage(routeId: DashboardRouteId, page: ReactNode) {
  return (
    <PageErrorBoundary resetKey={routeId}>{page}</PageErrorBoundary>
  );
}

export function App({
  fetchImpl,
  uploadTransport,
  fleetTransport,
  statisticsClient,
  operationsClient,
}: AppProps = {}) {
  return (
    <AdminShell fetchImpl={fetchImpl}>
      <TotpSetupScreen />
      <NavigationFrame
        taxiPage={guardedPage(
          "taxis",
          <FleetPage fetchImpl={fetchImpl} transport={fleetTransport} />,
        )}
        mediaPage={guardedPage(
          "medien",
          <MediaPage
            fetchImpl={fetchImpl}
            uploadTransport={uploadTransport}
          />,
        )}
        campaignPage={guardedPage(
          "kampagnen",
          <CampaignPage fetchImpl={fetchImpl} />,
        )}
        previewPage={guardedPage(
          "ausspielung",
          <PlayoutPreviewPage
            fetchImpl={fetchImpl}
            transport={fleetTransport}
          />,
        )}
        statisticPage={guardedPage(
          "statistik",
          <StatisticsPage client={statisticsClient} fetchImpl={fetchImpl} />,
        )}
        operationsPage={guardedPage(
          "betrieb",
          <>
            <OperationsPage client={operationsClient} fetchImpl={fetchImpl} />
            {/* App-Updates aus der Ferne: Versionen hochladen und freigeben. */}
            <AppUpdatesPanel fetchImpl={fetchImpl} />
          </>,
        )}
      />
    </AdminShell>
  );
}

export default App;
