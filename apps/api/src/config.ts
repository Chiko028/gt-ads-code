import { isValidPasswordHash } from "./crypto/password.js";

/** Erlaubte Laufzeitumgebungen (AC-14, DATENTRENNUNG Abschnitt 2.1). */
export type AppEnv = "dev" | "test";

/** Geprüfte, unveränderliche Konfiguration des API-Prozesses. */
export interface AppConfig {
  readonly env: AppEnv;
  readonly bindHost: string;
  readonly port: number;
  readonly databaseUrl: string;
  /**
   * Optionales, bereits ueber CX-030/031 gespeichertes GT-Ads-Platzhaltermedium
   * fuer die Manifest-Erzeugung (R-305). null bedeutet "nicht konfiguriert".
   */
  readonly fallbackMediaId?: string | null;
  readonly registrationCodePepper: string;
  readonly adminPasswordHash: string;
  readonly registrationCodeTtlSeconds: number;
  readonly registrationCodeLength: number;
  readonly registrationMaxFailsPerSource: number;
  readonly registrationMaxFailsWindowSeconds: number;
  readonly registrationMaxFailsGlobalPerHour: number;
  readonly challengeTtlSeconds: number;
  readonly accessTokenTtlSeconds: number;
  readonly heartbeatIntervalSeconds: number;
  readonly onlineThresholdSeconds: number;
  readonly adminSessionTtlSeconds: number;
  readonly cookieSecure: boolean;
}

/**
 * Start verweigert. Die Meldung nennt nur Variablennamen und niemals Werte,
 * damit keine Geheimnisse in Logs oder Fehlermeldungen gelangen.
 */
export class ConfigError extends Error {
  readonly variables: readonly string[];

  constructor(message: string, variables: readonly string[] = []) {
    super(message);
    this.name = "ConfigError";
    this.variables = variables;
  }
}

/** Standardwerte laut SPEZIFIKATION.md Abschnitt 7 (Annahmen [A] des Planers). */
export const CONFIG_DEFAULTS = Object.freeze({
  bindHost: "127.0.0.1",
  port: 8080,
  registrationCodeTtlSeconds: 900,
  registrationCodeLength: 12,
  registrationMaxFailsPerSource: 5,
  registrationMaxFailsWindowSeconds: 900,
  registrationMaxFailsGlobalPerHour: 30,
  challengeTtlSeconds: 60,
  accessTokenTtlSeconds: 900,
  heartbeatIntervalSeconds: 900,
  onlineThresholdSeconds: 1800,
  adminSessionTtlSeconds: 3600,
  cookieSecure: false,
});

const ALLOWED_ENVIRONMENTS: readonly string[] = ["dev", "test"];

/** Nur die kanonische UUID-Form; der Wert wird als Medien-ID gebunden. */
const MEDIA_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requiredRaw(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    throw new ConfigError(name + " fehlt oder ist leer", [name]);
  }
  return raw;
}

function optionalString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  return raw.trim();
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new ConfigError(name + " muss eine ganze Zahl sein", [name]);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigError(
      name + " muss zwischen " + minimum + " und " + maximum + " liegen",
      [name],
    );
  }
  return value;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new ConfigError(name + " muss true oder false sein", [name]);
}

function readOptionalMediaId(
  env: NodeJS.ProcessEnv,
  name: string,
): string | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  const value = raw.trim();
  if (!MEDIA_UUID_PATTERN.test(value)) {
    throw new ConfigError(name + " muss eine gueltige Medien-UUID sein", [name]);
  }
  return value.toLowerCase();
}

function readAppEnv(env: NodeJS.ProcessEnv): AppEnv {
  const raw = env.GT_ADS_ENV;
  if (raw === undefined || raw.trim() === "") {
    throw new ConfigError(
      "GT_ADS_ENV fehlt; erlaubt sind nur dev und test",
      ["GT_ADS_ENV"],
    );
  }
  const value = raw.trim();
  if (!ALLOWED_ENVIRONMENTS.includes(value)) {
    throw new ConfigError(
      "GT_ADS_ENV=" + value + " ist nicht erlaubt; erlaubt sind nur dev und test",
      ["GT_ADS_ENV"],
    );
  }
  return value as AppEnv;
}

/**
 * Liest und validiert die Umgebung. Wirft ConfigError, wenn der Prozess nicht
 * starten darf (AC-14): GT_ADS_ENV fehlt/prod/anderes, Pflichtgeheimnisse
 * fehlen oder der Passwort-Hash ist kein gültiger scrypt-Hash.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const appEnv = readAppEnv(env);

  const registrationCodePepper = requiredRaw(env, "GT_ADS_CODE_PEPPER");
  const adminPasswordHash = requiredRaw(env, "GT_ADS_ADMIN_PASSWORD_HASH").trim();
  if (!isValidPasswordHash(adminPasswordHash)) {
    throw new ConfigError(
      "GT_ADS_ADMIN_PASSWORD_HASH ist kein gueltiger scrypt-Hash " +
        "(erwartet: scrypt$N=...,r=...,p=...$salt$hash)",
      ["GT_ADS_ADMIN_PASSWORD_HASH"],
    );
  }

  const databaseUrl = requiredRaw(env, "GT_ADS_DB_URL").trim();
  const bindHost = optionalString(env, "GT_ADS_BIND_HOST", CONFIG_DEFAULTS.bindHost);

  const config: AppConfig = {
    env: appEnv,
    bindHost,
    port: readInteger(env, "GT_ADS_PORT", CONFIG_DEFAULTS.port, 1, 65535),
    databaseUrl,
    fallbackMediaId: readOptionalMediaId(
      env,
      "GT_ADS_MANIFEST_FALLBACK_MEDIA_ID",
    ),
    registrationCodePepper,
    adminPasswordHash,
    registrationCodeTtlSeconds: readInteger(
      env,
      "GT_ADS_REG_CODE_TTL_S",
      CONFIG_DEFAULTS.registrationCodeTtlSeconds,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    registrationCodeLength: readInteger(
      env,
      "GT_ADS_REG_CODE_LENGTH",
      CONFIG_DEFAULTS.registrationCodeLength,
      1,
      128,
    ),
    registrationMaxFailsPerSource: readInteger(
      env,
      "GT_ADS_REG_MAX_FAILS_PER_SOURCE",
      CONFIG_DEFAULTS.registrationMaxFailsPerSource,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    registrationMaxFailsWindowSeconds: readInteger(
      env,
      "GT_ADS_REG_MAX_FAILS_WINDOW_S",
      CONFIG_DEFAULTS.registrationMaxFailsWindowSeconds,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    registrationMaxFailsGlobalPerHour: readInteger(
      env,
      "GT_ADS_REG_MAX_FAILS_GLOBAL_PER_H",
      CONFIG_DEFAULTS.registrationMaxFailsGlobalPerHour,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    challengeTtlSeconds: readInteger(
      env,
      "GT_ADS_CHALLENGE_TTL_S",
      CONFIG_DEFAULTS.challengeTtlSeconds,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    accessTokenTtlSeconds: readInteger(
      env,
      "GT_ADS_ACCESS_TOKEN_TTL_S",
      CONFIG_DEFAULTS.accessTokenTtlSeconds,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    heartbeatIntervalSeconds: readInteger(
      env,
      "GT_ADS_HEARTBEAT_INTERVAL_S",
      CONFIG_DEFAULTS.heartbeatIntervalSeconds,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    onlineThresholdSeconds: readInteger(
      env,
      "GT_ADS_ONLINE_THRESHOLD_S",
      CONFIG_DEFAULTS.onlineThresholdSeconds,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    adminSessionTtlSeconds: readInteger(
      env,
      "GT_ADS_ADMIN_SESSION_TTL_S",
      CONFIG_DEFAULTS.adminSessionTtlSeconds,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    cookieSecure: readBoolean(env, "GT_ADS_COOKIE_SECURE", CONFIG_DEFAULTS.cookieSecure),
  };

  return Object.freeze(config);
}

/**
 * True, wenn die Bind-Adresse nicht ausschliesslich lokal ist (AC-20).
 * Der Server kann davor warnen; der Standard bleibt 127.0.0.1.
 */
export function isPubliclyReachableBind(bindHost: string): boolean {
  return bindHost !== "127.0.0.1" && bindHost !== "::1" && bindHost !== "localhost";
}
