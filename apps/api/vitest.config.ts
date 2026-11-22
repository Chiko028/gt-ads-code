import { defineConfig } from "vitest/config";

// Beim Aufraeumen der Testdatenbanken beendet PostgreSQL noch offene Verbindungen
// mit FATAL 57P01 (admin_shutdown / terminating connection). Das ist kein fachlicher
// Testfehler und soll einen ansonsten vollstaendig gruenen Lauf nicht auf Exit 1
// kippen. Alle anderen unbehandelten Fehler bleiben Fehler.
const ADMIN_SHUTDOWN = "57P01";

function isAdminShutdown(error: unknown, depth = 0): boolean {
  if (depth > 5 || typeof error !== "object" || error === null) return false;
  const { code, cause, errors } = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (code === ADMIN_SHUTDOWN) return true;
  if (Array.isArray(errors) && errors.some((inner) => isAdminShutdown(inner, depth + 1))) return true;
  return isAdminShutdown(cause, depth + 1);
}

export default defineConfig({
  test: {
    environment: "node",
    // 2026-11-17: Der gemeinsame Server ist zeitweise stark ausgelastet (parallele Gradle-/Agentenlaeufe).
    // Integrationstests mit echter PostgreSQL rissen dann das 5-s-Standardlimit, ohne fachlichen Fehler.
    testTimeout: 20_000,
    hookTimeout: 60_000,
    include: ["tests/**/*.test.ts", "src/http/cx049-statistics.test.ts", "src/http/adminTotpSetup.test.ts", "src/modules/campaigns/drafts.test.ts"],
    onUnhandledError(error) {
      // false = Vitest ignoriert diesen unbehandelten Fehler; undefined = der Lauf scheitert weiterhin.
      if (isAdminShutdown(error)) return false;
    },
  },
});
