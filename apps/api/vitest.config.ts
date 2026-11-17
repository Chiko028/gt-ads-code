import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // 2026-11-17: Der gemeinsame Server ist zeitweise stark ausgelastet (parallele Gradle-/Agentenlaeufe).
    // Integrationstests mit echter PostgreSQL rissen dann das 5-s-Standardlimit, ohne fachlichen Fehler.
    testTimeout: 20_000,
    hookTimeout: 60_000,
    include: ["tests/**/*.test.ts", "src/http/cx049-statistics.test.ts", "src/http/adminTotpSetup.test.ts", "src/modules/campaigns/drafts.test.ts"],
  },
});
