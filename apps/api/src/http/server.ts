import { join } from "node:path";
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
import { registerAdminOperatorRoutes } from "../modules/adminAuth/operatorRoutes.js";
import {
  deriveAdminTotpEncryptionKey,
  registerAdminTotpSetupConfirmRoutes,
} from "../modules/adminAuth/totpSetupConfirm.js";
import { registerAdminTotpSetupCancelRoutes } from "../modules/adminAuth/totpSetupCancel.js";
import { registerAdminTotpSetupRoutes } from "./adminTotpSetup.js";
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
import { createTelemetryIngestService } from "../modules/telemetry/index.js";
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
import { installAccessControl } from "./authorization.js";
import {
  createLegacyAdminPrincipalResolver,
  type PrincipalResolver,
} from "./principal.js";
import { registerAuditReadRoutes } from "./auditRead.js";
import {
  createMedia,
  listReadyMedia,
  type MediaServiceOptions,
} from "../modules/media/index.js";
import type { MediaUploadDeps } from "./mediaUpload.js";
import type { MediaListDeps } from "./mediaList.js";
import { registerHttpComposition } from "./composition.js";
import {
  createManifestRefresh,
  manifestKeyFromConfig,
  registerDeviceDeliveryRoutes,
  startManifestDrain,
} from "../modules/deviceDelivery/index.js";
import {
  createOperationsAlarmAdapter,
  type OperationsAlarmAdapterOptions,
} from "./operationsAlarmAdapter.js";
import {
  registerOperationsBackupCheckRoutes,
  type OperationsBackupCheckRouteOptions,
  type BackupCheckTestConfiguration,
} from "./operationsBackupCheck.js";
import { registerOperationsOverviewRoutes } from "./operationsOverview.js";
import {
  createRegistrationRateLimiter,
  type RegistrationRateLimiter,
} from "./rateLimit.js";

/** Version laut API-VERTRAG.md Abschnitt 6 (Antwort von /health). */
export const API_VERSION = "0.1.0";

/** CX-060: austauschbare Alarmgrenzen fuer Tests und R-702. */
export interface OperationsAlarmOptions {
  service?: OperationsAlarmAdapterOptions["alarmService"];
  sender?: OperationsAlarmAdapterOptions["sender"];
  reportTimeoutMs?: number;
}

/**
 * CX-061: serverseitige Testkonfiguration und Auditgrenze fuer den
 * Admin-Backup-Nachweis. Ohne configuration bleibt die Aktion deaktiviert.
 */
export interface OperationsBackupCheckOptions {
  configuration?: BackupCheckTestConfiguration | null;
  audit?: OperationsBackupCheckRouteOptions["audit"];
  /** Nur fuer Tests/explizite Verdrahtung: abweichender CX-060-Port. */
  alarm?: OperationsBackupCheckRouteOptions["alarm"];
}

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
  /** CX-060: Alarmverdrahtung fuer Readiness und Backup-Nachweise. */
  operationsAlarm?: OperationsAlarmOptions;
  /** CX-061: nur mit expliziter Testkonfiguration aktiver Backup-Nachweis. */
  operationsBackupCheck?: OperationsBackupCheckOptions;
  /**
   * Nur fuer Tests: injizierter serverseitiger Principal-Resolver. Ohne
   * Angabe gilt ausschliesslich die vorhandene Sitzungspruefung.
   */
  resolvePrincipal?: PrincipalResolver;
  /**
   * Injizierbare Upload-Servicegrenze (CX-031). Ohne Angabe wird der reale
   * CX-030-Speicher verwendet; es gibt keinen Testschalter im Laufzeitpfad.
   */
  mediaUpload?: MediaUploadDeps;
  /**
   * Nur fuer Tests/explizite Verdrahtung: 32-Byte-Schluessel des CX-106-
   * Einrichtungsspeichers. Ohne Angabe wird er domaenenspezifisch aus dem
   * vorhandenen Servergeheimnis abgeleitet.
   */
  mfaTotpEncryptionKey?: Buffer | Uint8Array;
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
        // CX-066: Einmalcode und TOTP-Code sind Geheimnisse.
        "req.body.code",
        "req.body.totp_code",
      ],
      censor: REDACTED,
    },
  };
}

/**
 * Reale Produktionsverdrahtung des vorhandenen CX-030-Speichers. Der
 * Ablageort ist ueber GT_ADS_MEDIA_STORAGE_ROOT waehlbar; ohne Angabe wird
 * ein relativer Standard verwendet. Die endgueltige Komposition folgt in
 * CX-033 und kann diese Grenze ersetzen.
 */
function resolveMediaStorageRoot(): string {
  const configured = process.env.GT_ADS_MEDIA_STORAGE_ROOT;
  if (configured !== undefined && configured.trim() !== "") {
    return configured.trim();
  }
  return join(process.cwd(), "media");
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
          code?: string;
        };
        error.statusCode = 400;
        // Bekannte Parsergrenze fuer den gekapselten Fehlerbaustein (CX-033);
        // der globale U7-Handler wertet weiterhin nur den Status aus.
        error.code = "FST_ERR_CTP_INVALID_JSON_BODY";
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

  // CX-060 / R-701: Die bestehende Readiness-Ausfuehrung bleibt der einzige
  // Ausloeser. Der Adapter meldet ihr Ergebnis an CX-028 und versendet neue
  // Episoden ueber den CX-029-Port; Fehler der Alarmspur aendern das
  // Pruefergebnis nicht.
  const operationsAlarm = createOperationsAlarmAdapter({
    pool,
    readiness,
    alarmService: options.operationsAlarm?.service,
    sender: options.operationsAlarm?.sender ?? null,
    now,
    reportTimeoutMs: options.operationsAlarm?.reportTimeoutMs,
  });

  const app = Fastify({
    logger: options.logger ?? defaultLogger(config),
    disableRequestLogging: true,
    trustProxy: false,
    bodyLimit: 64 * 1024,
  });

  registerJsonBodyParser(app);

  // Cookie-Sitzung des Dashboards (API-VERTRAG.md Abschnitt 5).
  void app.register(cookie);

  // Zentraler Rechtekern (CX-015): Die Erfassung wird vor jeder
  // Routenregistrierung installiert; Identitaeten stammen ausschliesslich aus
  // der vorhandenen serverseitigen Sitzungspruefung.
  const adminAuthService = new AdminAuthService({ pool, config, now });
  const resolvePrincipal =
    options.resolvePrincipal ??
    createLegacyAdminPrincipalResolver(adminAuthService);
  installAccessControl(app, { resolvePrincipal });

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
  const adminLoginLimiter = createAdminLoginRateLimiter(config, () =>
    now().getTime(),
  );
  registerAdminAuthRoutes(app, {
    service: adminAuthService,
    loginLimiter: adminLoginLimiter,
    config,
  });
  // CX-107 / R-605: Beginn der TOTP-Einrichtung unter derselben
  // Admin-Sitzung und demselben Fehlversuchszaehler.
  registerAdminTotpSetupRoutes(app, {
    pool,
    adminAuth: adminAuthService,
    config,
    loginLimiter: adminLoginLimiter,
    encryptionKey:
      options.mfaTotpEncryptionKey ??
      deriveAdminTotpEncryptionKey(config.registrationCodePepper),
    now,
  });
  // CX-108 / R-605: Abschluss der TOTP-Einrichtung unter derselben
  // Admin-Sitzung und demselben Fehlversuchszaehler.
  registerAdminTotpSetupConfirmRoutes(app, {
    pool,
    adminAuth: adminAuthService,
    config,
    loginLimiter: adminLoginLimiter,
    totpEncryptionKey:
      options.mfaTotpEncryptionKey ??
      deriveAdminTotpEncryptionKey(config.registrationCodePepper),
    now,
  });
  // CX-109 / R-605: Abbruch einer ausstehenden TOTP-Einrichtung desselben
  // Admins, serialisiert mit der Bestaetigung.
  registerAdminTotpSetupCancelRoutes(app, {
    pool,
    adminAuth: adminAuthService,
    now,
  });
  // CX-057 / R-602: Operatorverwaltung bleibt ausschliesslich Admin.
  registerAdminOperatorRoutes(app, { service: adminAuthService });
  registerAdminRegistrationCodeRoutes(app, {
    service,
    adminAuth: adminAuthService,
  });
  const devicesService = new DevicesService({ pool, config, now });
  registerAdminDeviceRoutes(app, {
    service: devicesService,
    adminAuth: adminAuthService,
  });
  // Geschuetzter Audit-Lesezugriff (CX-016 / R-603): nur Admin (audit.read).
  registerAuditReadRoutes(app, { pool });

  // Medien-Upload (CX-031 / R-202). Der Adapter delegiert genau einmal an
  // die vorhandene CX-030-Grenze createMedia(options, input); die
  // allgemeine Modulkomposition bleibt CX-033 vorbehalten.
  // CX-148: Manifest-Erzeugung (CX-041) mit dem konfigurierten Signierschluessel. Ohne
  // Schluessel bleibt alles wie bisher (keine Manifeste, keine Auslieferung).
  const manifestKey = manifestKeyFromConfig(config);
  const manifestRefresh = createManifestRefresh(pool, config, manifestKey, options.now);
  const mediaServiceOptions: MediaServiceOptions = {
    pool,
    storageRoot: resolveMediaStorageRoot(),
    ...(manifestRefresh ? { manifestRefresh } : {}),
  };
  const mediaUpload: MediaUploadDeps =
    options.mediaUpload ?? {
      createMedia,
      serviceOptions: mediaServiceOptions,
    };
  // CX-095: Die Liste nutzt dieselbe vorhandene CX-030-Servicegrenze und
  // denselben Speicher; es gibt keinen zweiten Medienbestand.
  const mediaList: MediaListDeps = {
    listReadyMedia,
    serviceOptions: mediaServiceOptions,
  };
  // Geraeteauthentifizierung (U4) wird vor der Komposition erzeugt, damit
  // auch das CX-042-Manifestplugin denselben Service nutzt.
  const deviceAuthService = new DeviceAuthService({ pool, config, now });

  // CX-046 / R-401: Der Ereigniseingang nutzt unveraendert den vorhandenen
  // CX-009-Speicherkern (Transaktion, Idempotenz, Konflikte, received_at).
  const telemetryIngest = createTelemetryIngestService({ client: pool, now });

  // CX-033: gemeinsamer Registrierungspunkt fuer die vorhandenen
  // Upload- und Kundenplugins. Jede App-Instanz registriert genau einmal.
  registerHttpComposition(app, {
    pool,
    adminAuth: adminAuthService,
    deviceAuth: deviceAuthService,
    mediaUpload,
    mediaList,
    telemetryIngest,
    onlineThresholdSeconds: config.onlineThresholdSeconds,
    now,
    ...(manifestRefresh ? { manifestRefresh } : {}),
    downloadSecret: config.downloadSecret ?? null,
  });
  app.decorate("adminAuthService", adminAuthService);

  // CX-148: Auslieferung an die Tablets (Konfiguration, Download-Freigabe, Download).
  registerDeviceDeliveryRoutes(app, {
    pool,
    deviceAuth: deviceAuthService,
    key: manifestKey,
    downloadSecret: config.downloadSecret ?? null,
    mediaOptions: mediaServiceOptions,
    now,
  });
  if (manifestRefresh) {
    startManifestDrain(app, manifestRefresh, (config.manifestDrainIntervalSeconds ?? 60) * 1000);
  }
  app.decorate("devicesService", devicesService);

  // Geraeteauthentifizierung (U4); die Middleware nutzt denselben Service.
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
    readiness: {
      check: () => operationsAlarm.checkReadinessOrThrow(),
    },
    metrics,
    readinessTimeoutMs: options.operations?.readinessTimeoutMs,
    scheduler: options.operations?.scheduler,
  });

  // CX-061 / R-702: duenne HTTP-Komposition des vorhandenen CX-023-Nachweises.
  // Ohne explizite serverseitige Testkonfiguration bleibt die Aktion vor
  // jedem Prozessstart deaktiviert.
  registerOperationsBackupCheckRoutes(app, {
    pool,
    environment: config.env,
    configuration: options.operationsBackupCheck?.configuration ?? null,
    resolvePrincipal,
    alarm:
      options.operationsBackupCheck?.alarm !== undefined
        ? options.operationsBackupCheck.alarm
        : operationsAlarm,
    now,
    ...(options.operationsBackupCheck?.audit === undefined
      ? {}
      : { audit: options.operationsBackupCheck.audit }),
  });

  // CX-061 / R-703: lesende Betriebsuebersicht ohne Backup-Ausloesung und
  // ohne alarmierende Readiness-Seiteneffekte. Die Rohsonde wird direkt
  // gelesen; der CX-060-Adapter bleibt hier absichtlich ungenutzt.
  registerOperationsOverviewRoutes(app, {
    pool,
    readiness,
    readinessTimeoutMs: options.operations?.readinessTimeoutMs,
    scheduler: options.operations?.scheduler,
    now,
  });

  return app;
}
