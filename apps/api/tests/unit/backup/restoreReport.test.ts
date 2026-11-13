import { describe, expect, it } from "vitest";
import {
  buildRestoreReport,
  RESTORE_REPORT_SCHEMA_VERSION,
  serializeRestoreReport,
  type RestoreReport,
  type RestoreReportInput,
} from "../../../src/modules/backup/restoreReport.js";

const ARCHIVE_SHA256 =
  "3f4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80912";
const CHECKED_AT = "2026-11-13T09:30:15.123Z";

function validInput(): RestoreReportInput {
  return {
    startedAt: CHECKED_AT,
    restoreDurationMs: 4321,
    artifactSha256: ARCHIVE_SHA256,
    toolVersions: {
      pgDump: "pg_dump (PostgreSQL) 16.3",
      pgRestore: "pg_restore (PostgreSQL) 16.3",
    },
    checks: {
      restore: true,
      content: true,
      foreignKeys: true,
      sequences: true,
      cleanup: true,
    },
  };
}

describe("restoreReport", () => {
  it("serialisiert einen vollstaendigen synthetischen Pruefnachweis roundtrip-faehig", () => {
    const input = validInput();

    const report = buildRestoreReport(input);

    expect(report.success).toBe(true);
    expect(report.schemaVersion).toBe(RESTORE_REPORT_SCHEMA_VERSION);
    expect(report.checkedAt).toBe(CHECKED_AT);
    expect(report.durationMs).toBe(4321);
    expect(report.archiveSha256).toBe(ARCHIVE_SHA256);
    expect(report.toolVersions).toEqual({
      pgDump: "pg_dump (PostgreSQL) 16.3",
      pgRestore: "pg_restore (PostgreSQL) 16.3",
    });
    expect(report.checks).toEqual({
      restore: true,
      content: true,
      foreignKeys: true,
      sequences: true,
      cleanup: true,
    });
    expect(report.errorCode).toBeNull();

    const json = serializeRestoreReport(input);
    const parsed: RestoreReport = JSON.parse(json);
    expect(parsed).toEqual(report);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);

    // Fehlende Werkzeugversionen werden ausdruecklich als unbekannt
    // dargestellt und nicht durch erfundene Werte ersetzt.
    const withoutVersions = buildRestoreReport({
      ...validInput(),
      toolVersions: undefined,
    });
    expect(withoutVersions.toolVersions).toEqual({
      pgDump: "unknown",
      pgRestore: "unknown",
    });
  });

  it("meldet keinen Erfolg bei fehlgeschlagenem Restore, fehlendem Pflichtnachweis oder fehlgeschlagener Bereinigung, auch bei success=true", () => {
    const cases: Array<{
      name: string;
      mutate: (input: RestoreReportInput) => RestoreReportInput;
    }> = [
      {
        name: "fehlgeschlagener Restore",
        mutate: (input) => ({
          ...input,
          checks: { ...input.checks, restore: false },
        }),
      },
      {
        name: "fehlender Pflichtnachweis Sequenzen",
        mutate: (input) => {
          const checks = { ...input.checks } as Partial<RestoreReportInput["checks"]>;
          delete checks.sequences;
          return {
            ...input,
            checks: checks as RestoreReportInput["checks"],
          };
        },
      },
      {
        name: "fehlgeschlagene Bereinigung",
        mutate: (input) => ({
          ...input,
          checks: { ...input.checks, cleanup: false },
        }),
      },
    ];

    for (const testCase of cases) {
      const input = testCase.mutate({ ...validInput(), success: true });
      const report = buildRestoreReport(input);

      expect(report.success, testCase.name).toBe(false);
      expect(report.errorCode, testCase.name).toBeNull();
    }
  });

  it("uebernimmt keine zusaetzlichen oder verschachtelten Geheimnisfelder und meldet unbekannte Fehler nur mit festem Code", () => {
    const input = {
      ...validInput(),
      success: true,
      password: "super-secret-password",
      connectionUrl: "postgres://user:super-secret-password@127.0.0.1:5432/gtads",
      processArgs: ["--password=super-secret-password"],
      stderr: "fatal: password=super-secret-password",
      checks: {
        ...validInput().checks,
        password: "super-secret-password",
        stderr: "fatal: password=super-secret-password",
      },
      toolVersions: {
        ...validInput().toolVersions,
        connectionUrl: "postgres://user:super-secret-password@127.0.0.1:5432/gtads",
      },
      error: {
        code: "unbekannter_sql_fehler",
        message: "postgres://user:super-secret-password@127.0.0.1:5432/gtads",
        stderr: "fatal: password=super-secret-password",
        processArgs: ["--password=super-secret-password"],
      },
    } as unknown as RestoreReportInput;

    const report = buildRestoreReport(input);
    const json = serializeRestoreReport(input);

    expect(report.success).toBe(false);
    expect(report.errorCode).toBe("unknown_error");
    expect(Object.keys(report).sort()).toEqual([
      "archiveSha256",
      "checkedAt",
      "checks",
      "durationMs",
      "errorCode",
      "schemaVersion",
      "success",
      "toolVersions",
    ]);
    expect(Object.keys(report.checks).sort()).toEqual([
      "cleanup",
      "content",
      "foreignKeys",
      "restore",
      "sequences",
    ]);
    expect(Object.keys(report.toolVersions).sort()).toEqual([
      "pgDump",
      "pgRestore",
    ]);

    for (const secret of [
      "super-secret-password",
      "postgres://",
      "processArgs",
      "stderr",
      "password",
      "unbekannter_sql_fehler",
    ]) {
      expect(json).not.toContain(secret);
    }
  });
});
