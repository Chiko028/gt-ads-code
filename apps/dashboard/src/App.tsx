import { AdminShell } from "./admin/AdminShell";
import type { FetchLike } from "./admin/adminApi";
import { NavigationFrame } from "./navigation/NavigationFrame";

export interface AppProps {
  /** Injizierbares fetch fuer Shell, Client und Tests. */
  readonly fetchImpl?: FetchLike;
}

export function App({ fetchImpl }: AppProps = {}) {
  return (
    <AdminShell fetchImpl={fetchImpl}>
      <NavigationFrame />
    </AdminShell>
  );
}

export default App;
