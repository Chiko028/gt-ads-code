import { beforeAll, describe, expect, it } from "vitest";
import {
  CONFIG_DEFAULTS,
  ConfigError,
  isPubliclyReachableBind,
  loadConfig,
} from "../../src/config.js";
import { hashPassword } from "../../src/crypto/password.js";

const PEPPER = "SYN-unit-test-pepper";
let passwordHash = "";

beforeAll(async () => {
  passwordHash = await hashPassword("SYN-unit-test-passwort");
});

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GT_ADS_ENV: "test",
    GT_ADS_DB_URL: "postgresql://synthetic@127.0.0.1:5432/gt_ads_test",
    GT_ADS_CODE_PEPPER: PEPPER,
    GT_ADS_ADMIN_PASSWORD_HASH: passwordHash,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

describe("U-07 Config-Guard", () => {
  it("verweigert fehlendes GT_ADS_ENV", () => {
    expect(() => loadConfig(baseEnv({ GT_ADS_ENV: undefined }))).toThrow(ConfigError);
    expect(() => loadConfig(baseEnv({ GT_ADS_ENV: undefined }))).toThrow(/GT_ADS_ENV/);
  });

  it("verweigert prod, staging und unbekannte Umgebungen", () => {
    for (const value of ["prod", "staging", "foo", "DEV"]) {
      expect(() => loadConfig(baseEnv({ GT_ADS_ENV: value })), value).toThrow(ConfigError);
      expect(() => loadConfig(baseEnv({ GT_ADS_ENV: value })), value).toThrow(/dev und test/);
    }
  });

  it("akzeptiert dev und test", () => {
    expect(loadConfig(baseEnv({ GT_ADS_ENV: "dev" })).env).toBe("dev");
    expect(loadConfig(baseEnv({ GT_ADS_ENV: "test" })).env).toBe("test");
    expect(loadConfig(baseEnv({ GT_ADS_ENV: " dev " })).env).toBe("dev");
  });

  it("setzt die Standardwerte aus SPEZIFIKATION Abschnitt 7", () => {
    const config = loadConfig(baseEnv());
    expect(config.bindHost).toBe("127.0.0.1");
    expect(config.port).toBe(8080);
    expect(config.registrationCodeTtlSeconds).toBe(900);
    expect(config.registrationCodeLength).toBe(12);
    expect(config.registrationMaxFailsPerSource).toBe(5);
    expect(config.registrationMaxFailsWindowSeconds).toBe(900);
    expect(config.registrationMaxFailsGlobalPerHour).toBe(30);
    expect(config.challengeTtlSeconds).toBe(60);
    expect(config.accessTokenTtlSeconds).toBe(900);
    expect(config.heartbeatIntervalSeconds).toBe(900);
    expect(config.onlineThresholdSeconds).toBe(1800);
    expect(config.adminSessionTtlSeconds).toBe(3600);
    expect(config.cookieSecure).toBe(false);
  });

  it("uebernimmt gueltige Overrides", () => {
    const config = loadConfig(
      baseEnv({
        GT_ADS_REG_CODE_TTL_S: "120",
        GT_ADS_REG_CODE_LENGTH: "8",
        GT_ADS_PORT: "9090",
        GT_ADS_BIND_HOST: "127.0.0.2",
        GT_ADS_COOKIE_SECURE: "true",
      }),
    );
    expect(config.registrationCodeTtlSeconds).toBe(120);
    expect(config.registrationCodeLength).toBe(8);
    expect(config.port).toBe(9090);
    expect(config.bindHost).toBe("127.0.0.2");
    expect(config.cookieSecure).toBe(true);
  });

  it("verweigert ungueltige Zahlen und Booleans", () => {
    for (const value of ["0", "-1", "5.5", "abc", "1e3"]) {
      expect(() => loadConfig(baseEnv({ GT_ADS_REG_CODE_TTL_S: value })), value).toThrow(ConfigError);
    }
    expect(() => loadConfig(baseEnv({ GT_ADS_PORT: "70000" }))).toThrow(ConfigError);
    expect(() => loadConfig(baseEnv({ GT_ADS_COOKIE_SECURE: "vielleicht" }))).toThrow(ConfigError);
  });

  it("verweigert fehlendes Pepper und fehlenden Passwort-Hash", () => {
    expect(() => loadConfig(baseEnv({ GT_ADS_CODE_PEPPER: undefined }))).toThrow(/GT_ADS_CODE_PEPPER/);
    expect(() => loadConfig(baseEnv({ GT_ADS_CODE_PEPPER: "   " }))).toThrow(/GT_ADS_CODE_PEPPER/);
    expect(() => loadConfig(baseEnv({ GT_ADS_ADMIN_PASSWORD_HASH: undefined }))).toThrow(
      /GT_ADS_ADMIN_PASSWORD_HASH/,
    );
  });

  it("verweigert ein ungueltiges Passwort-Hashformat", () => {
    expect(() => loadConfig(baseEnv({ GT_ADS_ADMIN_PASSWORD_HASH: "klartext" }))).toThrow(
      /GT_ADS_ADMIN_PASSWORD_HASH/,
    );
    expect(() =>
      loadConfig(baseEnv({ GT_ADS_ADMIN_PASSWORD_HASH: "scrypt$N=16384,r=8,p=1$AAAA$BBBB" })),
    ).toThrow(ConfigError);
  });

  it("verweigert fehlende GT_ADS_DB_URL", () => {
    expect(() => loadConfig(baseEnv({ GT_ADS_DB_URL: undefined }))).toThrow(/GT_ADS_DB_URL/);
  });

  it("nennt in Fehlermeldungen keine Geheimniswerte", () => {
    const secretPepper = "SYN-sehr-geheimer-pepper";
    try {
      loadConfig(baseEnv({ GT_ADS_CODE_PEPPER: secretPepper, GT_ADS_ENV: "prod" }));
      throw new Error("loadConfig haette werfen muessen");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain(secretPepper);
    }

    try {
      loadConfig(baseEnv({ GT_ADS_ADMIN_PASSWORD_HASH: "SYN-GEHEIMER-HASH" }));
      throw new Error("loadConfig haette werfen muessen");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain("SYN-GEHEIMER-HASH");
    }
  });

  it("erkennt oeffentlich erreichbare Bind-Adressen (AC-20)", () => {
    expect(isPubliclyReachableBind(CONFIG_DEFAULTS.bindHost)).toBe(false);
    expect(isPubliclyReachableBind("::1")).toBe(false);
    expect(isPubliclyReachableBind("localhost")).toBe(false);
    expect(isPubliclyReachableBind("0.0.0.0")).toBe(true);
    expect(isPubliclyReachableBind("192.0.2.10")).toBe(true);
  });
});
