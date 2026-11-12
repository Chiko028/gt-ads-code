import {
  generateKeyPairSync,
  randomUUID,
  sign as signWithKey,
  type KeyObject,
} from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { CONFIG_DEFAULTS, type AppConfig } from "../../src/config.js";
import { buildSignatureMessage } from "../../src/crypto/deviceSignature.js";
import {
  decodeBase64Url,
  generateOpaqueToken,
  hashNonce,
} from "../../src/crypto/tokens.js";
import { migrateUp } from "../../src/db/migrate.js";
import { createServer } from "../../src/http/server.js";
import { createDeviceAuthMiddleware } from "../../src/modules/deviceAuth/middleware.js";
import { DeviceAuthService } from "../../src/modules/deviceAuth/service.js";
import { RegistrationService } from "../../src/modules/registration/service.js";

const BASE_TIME = Date.parse("2026-01-01T12:00:00.000Z");

const DEVICE_INFO = {
  manufacturer: "SYN-Hersteller",
  model: "SYN-Modell",
  os_version: "14",
  sdk_int: 34,
  app_version: "0.1.0",
  app_flavor: "dev",
};

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
let registrationService: RegistrationService;
let nowMs = BASE_TIME;
const clock = (): Date => new Date(nowMs);
const openApps: FastifyInstance[] = [];

function baseConnection(): {
  host: string;
  port: number;
  user: string;
  database: string;
} {
  const host = process.env.PGHOST;
  const user = process.env.PGUSER;
  const database = process.env.PGDATABASE;
  if (host === undefined || user === undefined || database === undefined) {
    throw new Error("GT-ADS-001 U4 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = ("gtads_u4_" + process.pid + "_" + Date.now().toString(36))
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(databaseName));

  pool = new Pool({ ...base, database: databaseName });
  await migrateUp(pool);

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-U4-Code-Pepper",
    adminPasswordHash:
      "scrypt$N=16384,r=8,p=1$c3ludGhldGlzY2hlLXNhbHQ$aGFzaC1oYXNoLWhhc2gtaGFzaC1oYXNo",
  };
  registrationService = new RegistrationService({ pool, config, now: clock });
}, 30_000);

beforeEach(() => {
  nowMs = BASE_TIME;
});

afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await app.close();
  }
});

afterAll(async () => {
  await pool.end();
  await maintenancePool.query(
    "drop database if exists " + quoteIdentifier(databaseName),
  );
  await maintenancePool.end();
}, 30_000);

async function buildApp(): Promise<FastifyInstance> {
  const app = createServer({ config, pool, now: clock });

  // Platzhalter fuer eine geraeteauthentifizierte Folgeroute (Heartbeat in U5).
  // Er nutzt dieselbe Middleware wie spaetere Produktionsrouten.
  const authService = new DeviceAuthService({ pool, config, now: clock });
  app.get(
    "/v1/device/auth/probe",
    { preHandler: createDeviceAuthMiddleware(authService) },
    async (request) => ({ device_id: request.deviceAuth?.deviceId ?? null }),
  );

  await app.ready();
  openApps.push(app);
  return app;
}

interface TestDevice {
  deviceId: string;
  privateKey: KeyObject;
  spki: string;
}

async function registerDevice(app: FastifyInstance): Promise<TestDevice> {
  const created = await registrationService.createRegistrationCode({
    label: "SYN-U4-Testhandy",
  });
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = pair.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");

  const response = await app.inject({
    method: "POST",
    url: "/v1/device/register",
    headers: {
      "content-type": "application/json",
      "x-gt-ads-api-version": "1",
    },
    payload: {
      registration_code: created.code,
      client_request_id: randomUUID(),
      public_key: spki,
      app_env: "test",
      device_info: { ...DEVICE_INFO },
    },
    remoteAddress: "192.0.2.80",
  });
  expect(response.statusCode).toBe(201);
  return {
    deviceId: response.json().device_id as string,
    privateKey: pair.privateKey,
    spki,
  };
}

function challenge(app: FastifyInstance, deviceId: string) {
  return app.inject({
    method: "POST",
    url: "/v1/device/auth/challenge",
    headers: {
      "content-type": "application/json",
      "x-gt-ads-api-version": "1",
    },
    payload: { device_id: deviceId },
    remoteAddress: "192.0.2.81",
  });
}

function requestToken(
  app: FastifyInstance,
  deviceId: string,
  nonce: string,
  signature: string,
) {
  return app.inject({
    method: "POST",
    url: "/v1/device/auth/token",
    headers: {
      "content-type": "application/json",
      "x-gt-ads-api-version": "1",
    },
    payload: { device_id: deviceId, nonce, signature },
    remoteAddress: "192.0.2.81",
  });
}

function probe(app: FastifyInstance, accessToken?: string) {
  const headers: Record<string, string> =
    accessToken === undefined ? {} : { authorization: "Bearer " + accessToken };
  return app.inject({
    method: "GET",
    url: "/v1/device/auth/probe",
    headers,
    remoteAddress: "192.0.2.82",
  });
}

async function waitForLockWaiters(minimum: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await maintenancePool.query<{ count: string }>(
      [
        "select count(*)::text as count",
        "  from pg_stat_activity",
        " where datname = $1",
        "   and wait_event_type = 'Lock'",
      ].join("\n"),
      [databaseName],
    );
    if (Number(result.rows[0]?.count ?? "0") >= minimum) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Geraeteauthentifizierung wartet nicht auf die Geraetesperre");
}

async function countAccessTokens(deviceId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "select count(*)::text as count from device_access_tokens where device_id = $1",
    [deviceId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

function signNonce(
  privateKey: KeyObject,
  deviceId: string,
  nonce: string,
): string {
  return signWithKey(
    "sha256",
    Buffer.from(buildSignatureMessage(deviceId, nonce), "utf8"),
    { key: privateKey, dsaEncoding: "der" },
  ).toString("base64");
}

function errorBody(response: { json: () => any }): {
  code: string;
  message: string;
  request_id: string;
} {
  return response.json().error;
}

describe("U4 Geraeteauthentifizierung (I-13 bis I-15)", () => {
  it("I-13 Challenge und Token im Erfolgsfall; Token authentifiziert Folgerequests", async () => {
    const app = await buildApp();
    const device = await registerDevice(app);

    const challengeResponse = await challenge(app, device.deviceId);
    expect(challengeResponse.statusCode).toBe(200);
    const challengeBody = challengeResponse.json();
    const decodedNonce = decodeBase64Url(challengeBody.nonce);
    expect(decodedNonce).not.toBeNull();
    expect(decodedNonce?.length).toBe(32);
    expect(new Date(challengeBody.expires_at).getTime()).toBe(
      nowMs + config.challengeTtlSeconds * 1000,
    );

    // Serverzeit bei Token-Ausstellung liegt 5 s spaeter.
    nowMs += 5000;
    const signature = signNonce(
      device.privateKey,
      device.deviceId,
      challengeBody.nonce,
    );
    const tokenResponse = await requestToken(
      app,
      device.deviceId,
      challengeBody.nonce,
      signature,
    );
    expect(tokenResponse.statusCode).toBe(200);
    const tokenBody = tokenResponse.json();
    expect(tokenBody.token_type).toBe("Bearer");
    const decodedToken = decodeBase64Url(tokenBody.access_token);
    expect(decodedToken).not.toBeNull();
    expect(decodedToken?.length).toBe(32);
    expect(new Date(tokenBody.expires_at).getTime()).toBe(
      nowMs + config.accessTokenTtlSeconds * 1000,
    );

    const deviceRow = await pool.query<{ last_seen_at: Date }>(
      "select last_seen_at from devices where id = $1",
      [device.deviceId],
    );
    expect(new Date(deviceRow.rows[0]?.last_seen_at as Date).getTime()).toBe(
      nowMs,
    );

    const nonceRows = await pool.query<{ nonce_hash: Buffer }>(
      "select nonce_hash from device_auth_challenges where device_id = $1",
      [device.deviceId],
    );
    expect(nonceRows.rows).toHaveLength(1);
    const storedHash = nonceRows.rows[0]?.nonce_hash as Buffer;
    expect(storedHash.equals(hashNonce(challengeBody.nonce))).toBe(true);
    expect(storedHash.toString("base64")).not.toContain(challengeBody.nonce);

    const protectedResponse = await probe(app, tokenBody.access_token);
    expect(protectedResponse.statusCode).toBe(200);
    expect(protectedResponse.json().device_id).toBe(device.deviceId);
  });

  it("I-14 falsche Signatur, wiederverwendete und abgelaufene Nonce sind challenge_invalid", async () => {
    const app = await buildApp();
    const device = await registerDevice(app);

    const wrongSignatureChallenge = await challenge(app, device.deviceId);
    expect(wrongSignatureChallenge.statusCode).toBe(200);
    const wrongKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const wrongSignature = signNonce(
      wrongKey.privateKey,
      device.deviceId,
      wrongSignatureChallenge.json().nonce,
    );
    const wrongSignatureResponse = await requestToken(
      app,
      device.deviceId,
      wrongSignatureChallenge.json().nonce,
      wrongSignature,
    );
    expect(wrongSignatureResponse.statusCode).toBe(401);
    expect(errorBody(wrongSignatureResponse).code).toBe("challenge_invalid");

    const reuseChallenge = await challenge(app, device.deviceId);
    expect(reuseChallenge.statusCode).toBe(200);
    const reuseNonce = reuseChallenge.json().nonce as string;
    const reuseSignature = signNonce(
      device.privateKey,
      device.deviceId,
      reuseNonce,
    );
    const firstUse = await requestToken(
      app,
      device.deviceId,
      reuseNonce,
      reuseSignature,
    );
    expect(firstUse.statusCode).toBe(200);
    const secondUse = await requestToken(
      app,
      device.deviceId,
      reuseNonce,
      reuseSignature,
    );
    expect(secondUse.statusCode).toBe(401);
    expect(errorBody(secondUse).code).toBe("challenge_invalid");

    const expiredChallenge = await challenge(app, device.deviceId);
    expect(expiredChallenge.statusCode).toBe(200);
    nowMs += (config.challengeTtlSeconds + 1) * 1000;
    const expiredSignature = signNonce(
      device.privateKey,
      device.deviceId,
      expiredChallenge.json().nonce,
    );
    const expiredResponse = await requestToken(
      app,
      device.deviceId,
      expiredChallenge.json().nonce,
      expiredSignature,
    );
    expect(expiredResponse.statusCode).toBe(401);
    expect(errorBody(expiredResponse).code).toBe("challenge_invalid");
  });

  it("I-14a wartende Token-Ausstellung prueft Challenge-Ablauf mit frischer Serverzeit", async () => {
    const app = await buildApp();
    const device = await registerDevice(app);

    const challengeResponse = await challenge(app, device.deviceId);
    expect(challengeResponse.statusCode).toBe(200);
    const nonce = challengeResponse.json().nonce as string;
    const signature = signNonce(device.privateKey, device.deviceId, nonce);

    const blocker = await pool.connect();
    let committed = false;
    try {
      await blocker.query("begin");
      await blocker.query(
        "select id from devices where id = $1 for update",
        [device.deviceId],
      );

      const pending = requestToken(app, device.deviceId, nonce, signature);
      await waitForLockWaiters(1);

      // Die Challenge laeuft ab, waehrend die Token-Ausstellung auf die
      // Geraetesperre wartet; die Ablehnung muss die frische Serverzeit nutzen.
      nowMs += (config.challengeTtlSeconds + 1) * 1000;

      await blocker.query("commit");
      committed = true;

      const response = await pending;
      expect(response.statusCode).toBe(401);
      expect(errorBody(response).code).toBe("challenge_invalid");
    } finally {
      if (!committed) {
        try {
          await blocker.query("rollback");
        } catch {
          // Die Sperre wird ohnehin mit der Verbindung freigegeben.
        }
      }
      blocker.release();
    }

    expect(await countAccessTokens(device.deviceId)).toBe(0);
    const challengeRow = await pool.query<{ used_at: Date | null }>(
      "select used_at from device_auth_challenges where device_id = $1",
      [device.deviceId],
    );
    expect(challengeRow.rows[0]?.used_at).toBeNull();
  });

  it("I-14b parallele Einloesung derselben Nonce erzeugt genau ein Token", async () => {
    const app = await buildApp();
    const device = await registerDevice(app);

    const challengeResponse = await challenge(app, device.deviceId);
    expect(challengeResponse.statusCode).toBe(200);
    const nonce = challengeResponse.json().nonce as string;
    const signature = signNonce(device.privateKey, device.deviceId, nonce);

    const blocker = await pool.connect();
    let committed = false;
    try {
      await blocker.query("begin");
      await blocker.query(
        "select id from devices where id = $1 for update",
        [device.deviceId],
      );

      // Beide Anfragen warten gleichzeitig auf die Geraetesperre; dadurch
      // laufen sie anschliessend mit getrennten Verbindungen um dieselbe Nonce.
      const pending = [
        requestToken(app, device.deviceId, nonce, signature),
        requestToken(app, device.deviceId, nonce, signature),
      ];
      await waitForLockWaiters(2);

      await blocker.query("commit");
      committed = true;

      const responses = await Promise.all(pending);
      const statuses = responses.map((response) => response.statusCode);
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      expect(statuses.filter((status) => status === 401)).toHaveLength(1);
      for (const response of responses) {
        if (response.statusCode === 401) {
          expect(errorBody(response).code).toBe("challenge_invalid");
        }
      }
    } finally {
      if (!committed) {
        try {
          await blocker.query("rollback");
        } catch {
          // Die Sperre wird ohnehin mit der Verbindung freigegeben.
        }
      }
      blocker.release();
    }

    expect(await countAccessTokens(device.deviceId)).toBe(1);
  });

  it("I-15 abgelaufenes, fehlendes und zufaelliges Token ergeben 401 unauthorized", async () => {
    const app = await buildApp();
    const device = await registerDevice(app);

    const challengeResponse = await challenge(app, device.deviceId);
    const nonce = challengeResponse.json().nonce as string;
    const signature = signNonce(device.privateKey, device.deviceId, nonce);
    const tokenResponse = await requestToken(
      app,
      device.deviceId,
      nonce,
      signature,
    );
    expect(tokenResponse.statusCode).toBe(200);
    const accessToken = tokenResponse.json().access_token as string;

    expect((await probe(app, accessToken)).statusCode).toBe(200);

    nowMs += (config.accessTokenTtlSeconds + 1) * 1000;
    const expired = await probe(app, accessToken);
    expect(expired.statusCode).toBe(401);
    expect(errorBody(expired).code).toBe("unauthorized");

    const withoutToken = await probe(app);
    expect(withoutToken.statusCode).toBe(401);
    expect(errorBody(withoutToken).code).toBe("unauthorized");

    const randomToken = await probe(app, generateOpaqueToken());
    expect(randomToken.statusCode).toBe(401);
    expect(errorBody(randomToken).code).toBe("unauthorized");

    const malformedHeader = await app.inject({
      method: "GET",
      url: "/v1/device/auth/probe",
      headers: { authorization: "Token " + generateOpaqueToken() },
      remoteAddress: "192.0.2.83",
    });
    expect(malformedHeader.statusCode).toBe(401);
    expect(errorBody(malformedHeader).code).toBe("unauthorized");
  });

  it("AC-08 (Teil): Sperre macht bestehende Tokens sofort ungueltig", async () => {
    const app = await buildApp();
    const device = await registerDevice(app);

    const challengeResponse = await challenge(app, device.deviceId);
    const nonce = challengeResponse.json().nonce as string;
    const signature = signNonce(device.privateKey, device.deviceId, nonce);
    const tokenResponse = await requestToken(
      app,
      device.deviceId,
      nonce,
      signature,
    );
    expect(tokenResponse.statusCode).toBe(200);
    const accessToken = tokenResponse.json().access_token as string;
    expect((await probe(app, accessToken)).statusCode).toBe(200);

    await pool.query(
      "update devices set state = 'revoked', revoked_at = $2, revoked_by = 'SYN-Admin' where id = $1",
      [device.deviceId, clock()],
    );

    const revokedProbe = await probe(app, accessToken);
    expect(revokedProbe.statusCode).toBe(403);
    expect(errorBody(revokedProbe).code).toBe("device_revoked");

    const revokedChallenge = await challenge(app, device.deviceId);
    expect(revokedChallenge.statusCode).toBe(403);
    expect(errorBody(revokedChallenge).code).toBe("device_revoked");
  });

  it("AC-08 (Teil): Widerruf waehrend wartender Token-Ausstellung wird nach Commit beachtet", async () => {
    const app = await buildApp();
    const device = await registerDevice(app);

    const challengeResponse = await challenge(app, device.deviceId);
    expect(challengeResponse.statusCode).toBe(200);
    const nonce = challengeResponse.json().nonce as string;
    const signature = signNonce(device.privateKey, device.deviceId, nonce);

    const blocker = await pool.connect();
    let committed = false;
    try {
      await blocker.query("begin");
      await blocker.query(
        "select id from devices where id = $1 for update",
        [device.deviceId],
      );

      const pending = requestToken(app, device.deviceId, nonce, signature);
      await waitForLockWaiters(1);

      // Der Widerruf wird commitet, waehrend die Token-Ausstellung noch auf
      // die Geraetesperre wartet; danach muss sie die gesperrte Zeile sehen.
      await blocker.query(
        "update devices set state = 'revoked', revoked_at = $2, revoked_by = 'SYN-Admin' where id = $1",
        [device.deviceId, clock()],
      );
      await blocker.query("commit");
      committed = true;

      const response = await pending;
      expect(response.statusCode).toBe(403);
      expect(errorBody(response).code).toBe("device_revoked");
    } finally {
      if (!committed) {
        try {
          await blocker.query("rollback");
        } catch {
          // Die Sperre wird ohnehin mit der Verbindung freigegeben.
        }
      }
      blocker.release();
    }

    expect(await countAccessTokens(device.deviceId)).toBe(0);
    const challengeRow = await pool.query<{ used_at: Date | null }>(
      "select used_at from device_auth_challenges where device_id = $1",
      [device.deviceId],
    );
    expect(challengeRow.rows[0]?.used_at).toBeNull();
  });

  it("unbekanntes Geraet bei der Challenge ergibt 401 unauthorized", async () => {
    const app = await buildApp();
    const response = await challenge(app, randomUUID());
    expect(response.statusCode).toBe(401);
    expect(errorBody(response).code).toBe("unauthorized");
  });
});
