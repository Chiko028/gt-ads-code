import { AdminShell } from "./admin/AdminShell";
import type { FetchLike } from "./admin/adminApi";
import { CampaignPage } from "./campaigns/CampaignPage";
import type { FleetTransport } from "./fleet/fleetApi";
import { FleetPage } from "./fleet/FleetPage";
import { MediaPage } from "./media/MediaPage";
import type { UploadTransport } from "./media/uploadTransport";
import { NavigationFrame } from "./navigation/NavigationFrame";
import { PlayoutPreviewPage } from "./playout/PlayoutPreviewPage";

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
}

export function App({
  fetchImpl,
  uploadTransport,
  fleetTransport,
}: AppProps = {}) {
  return (
    <AdminShell fetchImpl={fetchImpl}>
      <NavigationFrame
        taxiPage={
          <FleetPage fetchImpl={fetchImpl} transport={fleetTransport} />
        }
        mediaPage={
          <MediaPage
            fetchImpl={fetchImpl}
            uploadTransport={uploadTransport}
          />
        }
        campaignPage={<CampaignPage fetchImpl={fetchImpl} />}
        previewPage={
          <PlayoutPreviewPage
            fetchImpl={fetchImpl}
            transport={fleetTransport}
          />
        }
      />
    </AdminShell>
  );
}

export default App;
