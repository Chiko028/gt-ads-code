import { AdminShell } from "./admin/AdminShell";
import { DevicesPanel } from "./devices/DevicesPanel";

export function App() {
  return (
    <AdminShell>
      <DevicesPanel />
    </AdminShell>
  );
}

export default App;
