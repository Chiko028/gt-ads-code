import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/http/cx049-statistics.test.ts", "src/http/cx051-customer-report.test.ts", "src/modules/campaigns/drafts.test.ts"],
  },
});
