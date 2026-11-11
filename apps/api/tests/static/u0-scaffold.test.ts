import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
];

function readText(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

type ComposeService = {
  image?: string;
  build?: { context?: string; dockerfile?: string };
  environment?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
};

type ComposeFile = {
  services?: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
};

function loadCompose(): ComposeFile {
  return parseYaml(readText("infra/compose/docker-compose.dev.yml")) as ComposeFile;
}

type PackageJson = {
  workspaces?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function loadPackage(relativePath: string): PackageJson {
  return JSON.parse(readText(relativePath)) as PackageJson;
}

const collectFiles = (path: string): string[] => {
  const absolute = isAbsolute(path) ? path : join(repoRoot, path);
  if (!existsSync(absolute)) {
    return [];
  }
  if (extname(absolute) !== "") {
    return [absolute];
  }
  const files: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "coverage" ||
      entry.name === ".git"
    ) {
      continue;
    }
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(child));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
};

describe("U0 Compose-Check", () => {
  it("veroeffentlicht nur die API auf 127.0.0.1:8080 und keinen DB-Port", () => {
    const compose = loadCompose();
    const services = compose.services ?? {};
    const api = services["api"];
    const db = services["db"];

    expect(api).toBeDefined();
    expect(db).toBeDefined();
    if (api === undefined || db === undefined) {
      throw new Error("Compose-Dienste api/db fehlen");
    }

    const servicesWithPorts = Object.entries(services)
      .filter(([, service]) => Array.isArray(service.ports) && service.ports.length > 0)
      .map(([name]) => name);

    expect(servicesWithPorts).toEqual(["api"]);
    expect(api.ports).toEqual(["127.0.0.1:8080:8080"]);
    expect(db.ports).toBeUndefined();
    expect(api.build?.dockerfile).toBe("apps/api/Dockerfile");
    expect(existsSync(join(repoRoot, "apps/api/Dockerfile"))).toBe(true);
    expect(Object.keys(compose.volumes ?? {})).toContain("gt_ads_db");
  });

  it("setzt GT_ADS_ENV=dev und pinnt alle Images ohne latest", () => {
    const compose = loadCompose();
    const api = compose.services?.["api"];
    const db = compose.services?.["db"];

    expect(api?.environment?.GT_ADS_ENV).toBe("dev");
    expect(db?.image).toMatch(/^postgres:17\.\d+-bookworm$/);

    expect(readText("infra/compose/docker-compose.dev.yml")).not.toMatch(/:latest\b/);

    const dockerfile = readText("apps/api/Dockerfile");
    const fromLines = dockerfile
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.toUpperCase().startsWith("FROM "));

    expect(fromLines.length).toBeGreaterThan(0);
    for (const line of fromLines) {
      const image = line.split(/\s+/)[1] ?? "";
      expect(image).toContain(":");
      expect(image.endsWith(":latest")).toBe(false);
    }
  });

  it("uebergibt die Pflichtgeheimnisse verpflichtend an den API-Container", () => {
    const compose = loadCompose();
    const environment = compose.services?.["api"]?.environment ?? {};

    expect(environment.GT_ADS_CODE_PEPPER).toMatch(
      /^\$\{GT_ADS_CODE_PEPPER:\?/,
    );
    expect(environment.GT_ADS_ADMIN_PASSWORD_HASH).toMatch(
      /^\$\{GT_ADS_ADMIN_PASSWORD_HASH:\?/,
    );
  });

  it("baut die API nach dist und uebernimmt das Artefakt ins Runtime-Image", () => {
    const apiPackage = loadPackage("apps/api/package.json");
    expect(apiPackage.scripts?.["build"]).toBeTruthy();
    expect(existsSync(join(repoRoot, "apps/api/src/index.ts"))).toBe(true);

    const buildConfig = JSON.parse(readText("apps/api/tsconfig.build.json")) as {
      compilerOptions?: { noEmit?: boolean; outDir?: string; rootDir?: string };
    };
    expect(buildConfig.compilerOptions?.noEmit).toBe(false);
    expect(buildConfig.compilerOptions?.outDir).toBe("dist");
    expect(buildConfig.compilerOptions?.rootDir).toBe("src");

    const dockerfile = readText("apps/api/Dockerfile");
    expect(dockerfile).toMatch(/RUN npm run build --workspace @gt-ads\/api/);
    expect(dockerfile).toMatch(/COPY --from=build \/app\/apps\/api\/dist/);
  });
});

describe("U0 Secret-Check", () => {
  it("enthaelt in .env.example nur Schluessel ohne Werte", () => {
    const content = readText(".env.example");
    const entries = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).toMatch(/^[A-Z][A-Z0-9_]*=$/);
    }

    for (const required of [
      "GT_ADS_ENV=",
      "GT_ADS_DB_URL=",
      "GT_ADS_CODE_PEPPER=",
      "GT_ADS_ADMIN_PASSWORD_HASH=",
    ]) {
      expect(entries).toContain(required);
    }
  });

  it("schuetzt .env per .gitignore, laesst aber .env.example zu", () => {
    const lines = readText(".gitignore").split("\n").map((line) => line.trim());
    expect(lines).toContain(".env");
    expect(lines).toContain("!.env.example");
  });

  it("findet keine typischen Geheimnis-Muster im U0-Scope", () => {
    const roots = ["apps/api", "apps/dashboard", "infra/compose", ".env.example", "package.json"];
    const files = roots.flatMap((root) => collectFiles(root));
    const findings: string[] = [];

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(text)) {
          findings.push(file + " passt auf " + pattern.source);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it("scannt auch verschachtelte Dateien (Regression: doppelter Repo-Praefix)", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "gt-ads-secret-scan-"));
    try {
      const nestedDirectory = join(tempRoot, "verschachtelt", "tiefer");
      mkdirSync(nestedDirectory, { recursive: true });
      const nestedFile = join(nestedDirectory, "synthetisch.txt");
      // Synthetisches Muster, im Testquelltext absichtlich zusammengesetzt,
      // damit der Secret-Scan diese Testdatei selbst nicht markiert.
      const syntheticSecret = ["ghp", "A".repeat(24)].join("_");
      writeFileSync(nestedFile, "token=" + syntheticSecret + "\n", "utf8");

      const files = collectFiles(tempRoot);
      expect(files).toContain(nestedFile);

      const findings = files.filter((file) =>
        SECRET_PATTERNS.some((pattern) => pattern.test(readFileSync(file, "utf8"))),
      );
      expect(findings).toContain(nestedFile);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("U0 Workspace-Check", () => {
  it("definiert die Workspaces apps/api und apps/dashboard", () => {
    const root = loadPackage("package.json");
    expect(root.workspaces).toEqual(["apps/api", "apps/dashboard"]);
    expect(root.scripts?.["typecheck"]).toBeTruthy();
    expect(root.scripts?.["test"]).toBeTruthy();
  });

  it("pinnt Abhaengigkeiten exakt und hat keine Lifecycle-Skripte", () => {
    const lifecycle = new Set(["preinstall", "install", "postinstall", "prepare"]);
    const exactVersion = /^\d+\.\d+\.\d+$/;
    const packageFiles = ["package.json", "apps/api/package.json", "apps/dashboard/package.json"];

    for (const file of packageFiles) {
      const pkg = loadPackage(file);
      const allDependencies = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };
      for (const [name, version] of Object.entries(allDependencies)) {
        expect(version, file + ": " + name).toMatch(exactVersion);
      }
      for (const script of Object.keys(pkg.scripts ?? {})) {
        expect(lifecycle.has(script), file + ": " + script).toBe(false);
      }
    }
  });
});
