import { pathToFileURL } from "node:url";
import { isPubliclyReachableBind, loadConfig, type AppConfig } from "./config.js";
import { createServer } from "./http/server.js";

export { createServer } from "./http/server.js";

/**
 * Startet den Prozess und beendet ihn bei SIGINT/SIGTERM geordnet.
 * Die fachlichen Routen werden in http/server.ts registriert.
 */
export async function startServer(config: AppConfig = loadConfig()): Promise<void> {
  const server = createServer(config);

  const shutdown = (signal: string): void => {
    server.log.info({ signal }, "Beende API");
    void server.close();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await server.listen({ host: config.bindHost, port: config.port });
  } catch (error: unknown) {
    server.log.error(error, "API-Start fehlgeschlagen");
    process.exitCode = 1;
    await server.close();
    return;
  }

  if (isPubliclyReachableBind(config.bindHost)) {
    server.log.warn(
      { bindHost: config.bindHost },
      "API lauscht nicht ausschliesslich lokal",
    );
  }
}

const entryPoint = process.argv[1];
const isDirectRun =
  entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href;

if (isDirectRun) {
  void startServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unbekannter Fehler";
    process.stderr.write("API-Start fehlgeschlagen: " + message + "\n");
    process.exitCode = 1;
  });
}
