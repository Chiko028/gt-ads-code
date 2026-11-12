import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const apiRoot = join(repoRoot, "apps", "api");
const artifact = join(apiRoot, "dist", "index.js");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const SYNTHETIC_PEPPER = "SYN-smoke-test-pepper";
const SYNTHETIC_DB_URL =
  "postgresql://synthetic:synthetic@127.0.0.1:1/gt_ads_smoke";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let cachedAdminHash: string | undefined;

function syntheticAdminPasswordHash(): string {
  if (cachedAdminHash === undefined) {
    const salt = randomBytes(16);
    const derived = scryptSync("SYN-smoke-test-passwort", salt, 32, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 128 * 16384 * 8 * 2,
    });
    cachedAdminHash =
      "scrypt$N=16384,r=8,p=1$" +
      salt.toString("base64url") +
      "$" +
      derived.toString("base64url");
  }
  return cachedAdminHash;
}

async function reserveFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Kein freier TCP-Port ermittelbar"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
  });
}

function baseServerEnv(port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GT_ADS_ENV: "test",
    GT_ADS_BIND_HOST: "127.0.0.1",
    GT_ADS_PORT: String(port),
    GT_ADS_DB_URL: SYNTHETIC_DB_URL,
    GT_ADS_CODE_PEPPER: SYNTHETIC_PEPPER,
    GT_ADS_ADMIN_PASSWORD_HASH: syntheticAdminPasswordHash(),
  };
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface RunningApi {
  child: ChildProcess;
  port: number;
  stdoutText: () => string;
  stderrText: () => string;
  exited: Promise<ExitInfo>;
}

async function startApi(): Promise<RunningApi> {
  const port = await reserveFreePort();
  const child = spawn(process.execPath, [artifact], {
    cwd: repoRoot,
    env: baseServerEnv(port),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const exited = new Promise<ExitInfo>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  return {
    child,
    port,
    stdoutText: () => stdout,
    stderrText: () => stderr,
    exited,
  };
}

async function waitForHealth(api: RunningApi): Promise<Response> {
  const deadline = Date.now() + 15000;
  let lastError = "";

  while (Date.now() < deadline) {
    if (api.child.exitCode !== null || api.child.signalCode !== null) {
      throw new Error(
        "API-Prozess endete vorzeitig (code=" +
          String(api.child.exitCode) +
          ", signal=" +
          String(api.child.signalCode) +
          "): " +
          api.stderrText(),
      );
    }

    try {
      const response = await fetch(
        "http://127.0.0.1:" + api.port + "/health",
        { signal: AbortSignal.timeout(1000) },
      );
      if (response.ok) {
        return response;
      }
      lastError = "HTTP " + response.status;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : "Unbekannter Fehler";
    }

    await delay(100);
  }

  throw new Error(
    "API wurde nicht erreichbar: " +
      lastError +
      "\nstdout:\n" +
      api.stdoutText() +
      "\nstderr:\n" +
      api.stderrText(),
  );
}

async function stopApi(api: RunningApi): Promise<ExitInfo> {
  if (api.child.exitCode === null && api.child.signalCode === null) {
    api.child.kill("SIGTERM");
  }

  const result = await Promise.race<ExitInfo | null>([
    api.exited,
    delay(8000).then(() => null),
  ]);

  if (result === null) {
    api.child.kill("SIGKILL");
    await api.exited;
    throw new Error(
      "API liess sich nach SIGTERM nicht kontrolliert beenden.\nstderr:\n" +
        api.stderrText(),
    );
  }

  return result;
}

describe("U0 Build-Smoke (REV-5)", () => {
  beforeAll(() => {
    rmSync(join(apiRoot, "dist"), { recursive: true, force: true });

    const build = spawnSync(
      npmCommand,
      ["run", "build", "--workspace", "@gt-ads/api"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 150000,
        env: process.env,
      },
    );

    if (build.error !== undefined) {
      throw new Error(
        "API-Build konnte nicht gestartet werden: " + build.error.message,
      );
    }
    if (build.status !== 0) {
      throw new Error(
        "API-Build fehlgeschlagen (status=" +
          String(build.status) +
          ")\nstdout:\n" +
          build.stdout +
          "\nstderr:\n" +
          build.stderr,
      );
    }

    expect(existsSync(artifact)).toBe(true);
  }, 180000);

  it("startet das gebaute dist/index.js und beendet es kontrolliert", async () => {
    const api = await startApi();
    try {
      const response = await waitForHealth(api);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        status: "ok",
        env: "test",
        version: "0.1.0",
      });
    } finally {
      const exit = await stopApi(api);
      expect(exit).toEqual({ code: 0, signal: null });
    }
  }, 60000);

  for (const variable of [
    "GT_ADS_CODE_PEPPER",
    "GT_ADS_ADMIN_PASSWORD_HASH",
  ] as const) {
    it("bricht den Start ohne " + variable + " ab", () => {
      const env = baseServerEnv(18080);
      delete env[variable];

      const result = spawnSync(process.execPath, [artifact], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
        timeout: 15000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(variable);
    }, 30000);
  }
});
