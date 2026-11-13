import { AdminShell } from "./admin/AdminShell";
import type { FetchLike } from "./admin/adminApi";
import { MediaPage } from "./media/MediaPage";
import type { UploadTransport } from "./media/uploadTransport";
import { NavigationFrame } from "./navigation/NavigationFrame";

export interface AppProps {
  /** Injizierbares fetch fuer Shell, Client und Tests. */
  readonly fetchImpl?: FetchLike;
  /**
   * Injizierbarer Upload-Transport fuer die Medienseite (CX-039). Ohne
   * Angabe wird der vorhandene XHR-Transport verwendet.
   */
  readonly uploadTransport?: UploadTransport;
}

export function App({ fetchImpl, uploadTransport }: AppProps = {}) {
  return (
    <AdminShell fetchImpl={fetchImpl}>
      <NavigationFrame
        mediaPage={
          <MediaPage
            fetchImpl={fetchImpl}
            uploadTransport={uploadTransport}
          />
        }
      />
    </AdminShell>
  );
}

export default App;
