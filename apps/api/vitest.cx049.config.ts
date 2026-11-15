import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["src/http/cx049-statistics.test.ts"] } });

