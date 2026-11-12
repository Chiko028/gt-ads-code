import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import cookie from "@fastify/cookie";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { startExpiredAuthCleanup } from "../db/cleanup.js";
import { createDatabasePool } from "../db/client.js";
import { AdminAuthService } from "../modules/adminAuth/service.js";
import {
  createAdminLoginRateLimiter,
  registerAdminAuthRoutes,
} from "../modules/adminAuth/routes.js";
import { DevicesService } from "../modules/devices/service.js";
import { registerAdminDeviceRoutes } from "../modules/devices/routes.js";
import { RegistrationService } from "../modules/registration/service.js";
import {
  registerAdminRegistrationCodeRoutes,
  registerRegistrationRoutes,
} from "../modules/registration/routes.js";
import { DeviceAuthService } from "../modules/deviceAuth/service.js";
import { registerDeviceAuthRoutes } from "../modules/deviceAuth/routes.js";
import { HeartbeatService } from "../modules/heartbeat/service.js";
import { registerHeartbeatRoutes } from "../modules/heartbeat/routes.js";
import { registerErrorHandler } from "./errors.js";
import { createOperationsMetrics } from "../modules/operations/metrics.js";
import { createPostgresReadinessProbe } from "../modules/operations/readiness.js";
import {
  isOperationsUrl,
  registerOperationsRoutes,
  type OperationsOverrides,
} from "../modules/operations/routes.js";
import { REDACTED, redactUrl } from "./logging.js";
import {
  createRegistrationRateLimiter,
  type RegistrationRateLimiter,
} from "./rateLimit.js";

/** Version laut API-VERTRAG.md Abschnitt 6 (Antwort von /health). */
export const API_VERSION = "0.1.0";

export interface ApiServerOptions {
  config: AppConfig;
  /** Fuer Tests wird ein eigener Pool uebergeben; sonst wird einer erzeugt. */
  pool?: Pool;
  /** Injizierbare Serveruhr (Tests, Statusableitung). */
  now?: () => Date;
  /** Fastify-Loggeroptionen; im Test z. B. ein mitschreibender Stream. */
  logger?: FastifyServerOptions["logger"];
  registrationRateLimiter?: RegistrationRateLimiter;
  /** Testbare Betriebsschnittstellen; ohne Angabe gelten die Produktionsadapter. */
  operations?: OperationsOverrides;
}

function defaultLogger(config: AppConfig): FastifyServerOptions["logger"] {
  if (config.env === "test") {
    return { level: "silent" };
  }
  return {
    level: "info",
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
        "req.body.registration_code",
        "req.body.public_key",
        "req.body.signature",
        "req.body.password",
      ],
      censor: REDACTED,
    },
  };
}

function isFullOptions(input: AppConfig | ApiServerOptions): input is ApiServerOptions {
  return "config" in input;
}

/**
 * Erlaubt leere JSON-Bodies (z. B. Logout oder DELETE ohne Inhalt), ohne den
 * Vertrag zu verletzen: der Content-Type bleibt Pflicht. Ungueltiges JSON
 * ergibt weiterhin 400 invalid_request.
 */
function registerJsonBodyParser(app: FastifyInstance): void {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      const text = typeof body === "string" ? body : body.toString("utf8");
      if (text.trim() === "") {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch {
        const error = new Error("Ungueltiges JSON") as Error & {
          statusCode?: number;
        };
        error.statusCode = 400;
        done(error);
      }
    },
  );
}

/**
 * Baut die API. Es werden bewusst keine Request-Bodies oder Header
 * protokolliert; die URL wird vor dem Loggen redigiert (AC-05, I-24).
 */
export function createServer(input: AppConfig | ApiServerOptions): FastifyInstance {
  const options: ApiServerOptions = isFullOptions(input) ? input : { config: input };
  const config = options.config;
  const now = options.now ?? (() => new Date());
  const ownsPool = options.pool === undefined;
  const pool = options.pool ?? createDatabasePool(config.databaseUrl);
  const limiter =
    options.registrationRateLimiter ?? createRegistrationRateLimiter(config);
  const metrics = options.operations?.metrics ?? createOperationsMetrics();
  const readiness =
    options.operations?.readiness ?? createPostgresReadinessProbe(pool);

  const app = Fastify({
    logger: options.logger ?? defaultLogger(config),
    disableRequestLogging: true,
    trustProxy: false,
    bodyLimit: 64 * 1024,
  });

  registerJsonBodyParser(app);

  // Cookie-Sitzung des Dashboards (API-VERTRAG.md Abschnitt 5).
  void app.register(cookie);

  // Abgelaufene Challenges/Tokens/Sitzungen: beim Start und stuendlich
  // bereinigen (ARCHITEKTUR.md Abschnitt 3).
  const stopCleanup = startExpiredAuthCleanup({
    executor: pool,
    now,
    onError: (error: unknown) => {
      app.log.warn({ errName: error instanceof Error ? error.name : "Unknown" }, "Bereinigung fehlgeschlagen");
    },
  });

  if (ownsPool) {
    app.addHook("onClose", async () => {
      await pool.end();
    });
  }
  app.addHook("onClose", async () => {
    stopCleanup();
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
  });

  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        url: redactUrl(request.url),
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime * 1000) / 1000,
      },
      "request completed",
    );
  });

  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url;
    if (isOperationsUrl(request.url, route)) {
      return;
    }
    metrics.observeRequest({
      method: request.method,
      route: route ?? null,
      statusCode: reply.statusCode,
      durationSeconds: reply.elapsedTime / 1000,
    });
  });

  registerErrorHandler(app);

  const service = new RegistrationService({ pool, config, now });
  registerRegistrationRoutes(app, { service, limiter, config });

  // Admin-Sitzung und Dashboard-Routen (U6).
  const adminAuthService = new AdminAuthService({ pool, config, now });
  registerAdminAuthRoutes(app, {
    service: adminAuthService,
    loginLimiter: createAdminLoginRateLimiter(config, () => now().getTime()),
    config,
  });
  registerAdminRegistrationCodeRoutes(app, {
    service,
    adminAuth: adminAuthService,
  });
  const devicesService = new DevicesService({ pool, config, now });
  registerAdminDeviceRoutes(app, {
    service: devicesService,
    adminAuth: adminAuthService,
  });
  app.decorate("adminAuthService", adminAuthService);
  app.decorate("devicesService", devicesService);

  // Geraeteauthentifizierung (U4); die Middleware nutzt denselben Service.
  const deviceAuthService = new DeviceAuthService({ pool, config, now });
  registerDeviceAuthRoutes(app, { service: deviceAuthService });
  app.decorate("deviceAuthService", deviceAuthService);

  // Heartbeat (U5): nutzt dieselbe Geraeteauthentifizierung wie U4.
  const heartbeatService = new HeartbeatService({ pool, config, now });
  registerHeartbeatRoutes(app, { service: heartbeatService, deviceAuth: deviceAuthService });

  app.get("/health", async () => ({
    status: "ok",
    env: config.env,
    version: API_VERSION,
  }));

  registerOperationsRoutes(app, {
    readiness,
    metrics,
    readinessTimeoutMs: options.operations?.readinessTimeoutMs,
    scheduler: options.operations?.scheduler,
  });

  return app;
}
