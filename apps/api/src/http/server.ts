import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { createDatabasePool } from "../db/client.js";
import { RegistrationService } from "../modules/registration/service.js";
import { registerRegistrationRoutes } from "../modules/registration/routes.js";
import { DeviceAuthService } from "../modules/deviceAuth/service.js";
import { registerDeviceAuthRoutes } from "../modules/deviceAuth/routes.js";
import { registerErrorHandler } from "./errors.js";
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

  const app = Fastify({
    logger: options.logger ?? defaultLogger(config),
    disableRequestLogging: true,
    trustProxy: false,
    bodyLimit: 64 * 1024,
  });

  if (ownsPool) {
    app.addHook("onClose", async () => {
      await pool.end();
    });
  }

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

  registerErrorHandler(app);

  const service = new RegistrationService({ pool, config, now });
  registerRegistrationRoutes(app, { service, limiter, config });

  // Geraeteauthentifizierung (U4); die Middleware nutzt denselben Service.
  const deviceAuthService = new DeviceAuthService({ pool, config, now });
  registerDeviceAuthRoutes(app, { service: deviceAuthService });
  app.decorate("deviceAuthService", deviceAuthService);

  app.get("/health", async () => ({
    status: "ok",
    env: config.env,
    version: API_VERSION,
  }));

  return app;
}
