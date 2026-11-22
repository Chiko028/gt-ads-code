import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:8080",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    // 2026-11-17: unter Serverlast rissen jsdom-Tests das 5-s-Standardlimit (z. B. NavigationFrame).
    testTimeout: 20_000,
    // Setzt configure({ asyncUtilTimeout: 5000 }) fuer alle Dashboard-Tests.
    setupFiles: ["src/tests/asyncUtilTimeout.ts"],
  },
});
