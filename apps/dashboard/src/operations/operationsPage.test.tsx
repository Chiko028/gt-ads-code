/**
 * CX-062 / R-703: echte Vitest-/jsdom-Komponententests mit vorhandener
 * Testing Library. Der Transport wird vollstaendig durch deterministische
 * Antworten bzw. einen reinen In-Memory-Server ersetzt; es gibt keine
 * Netzverbindung und keine Backup-Pruefung.
 */
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { FetchLike } from "../admin/adminApi";
import { AdminApiError } from "../admin/adminApi";
import { AdminShell } from "../admin/AdminShell";
import { App } from "../App";
import { NavigationFrame } from "../navigation/NavigationFrame";
import type {
  OperationsAlarmItem,
  OperationsBackupProof,
  OperationsClient,
  OperationsOverview,
  OperationsRequestOptions,
} from "./operationsApi";
import { OperationsPage } from "./OperationsPage";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Sessionstub fuer AdminShell; die Betriebsseite nutzt einen eigenen Client. */
const sessionFetch: FetchLike = (input, init) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (method === "GET" && url.endsWith("/admin/registration-codes")) {
    return Promise.resolve(jsonResponse(200, { items: [] }));
  }
  return Promise.resolve(
    jsonResponse(404, { error: { code: "not_found" } }),
  );
};

function alarmItem(
  overrides: Partial<OperationsAlarmItem> = {},
): OperationsAlarmItem {
  return {
    id: "alarm-1",
    at: "2026-11-16T04:00:00.000Z",
    action: "technical_alarm.episode.opened",
    episodeId: "episode-1",
    resourceId: "ressource-1",
    errorCode: "code-1",
    resolvedAt: null,
    unknownFields: [],
    ...overrides,
  };
}

function backupProof(
  overrides: Partial<OperationsBackupProof> = {},
): OperationsBackupProof {
  return {
    eventId: "event-1",
    runId: "backup-lauf-1",
    startedAt: "2026-11-16T02:59:00.000Z",
    finishedAt: "2026-11-16T03:00:00.000Z",
    durationMs: 60000,
    status: "succeeded",
    archiveSha256: "a".repeat(64),
    checks: {
      restore: true,
      content: true,
      foreignKeys: true,
      sequences: true,
      cleanup: true,
    },
    errorCode: null,
    unknownFields: [],
    ...overrides,
  };
}

function overview(
  overrides: Partial<OperationsOverview> = {},
): OperationsOverview {
  return {
    generatedAt: "2026-11-16T04:56:00.000Z",
    readiness: {
      status: "ready",
      checkedAt: "2026-11-16T04:55:00.000Z",
    },
    alarms: { available: true, reason: null, items: [] },
    lastBackupCheck: {
      available: true,
      reason: null,
      proof: backupProof(),
    },
    ...overrides,
  };
}

interface CapturedClient {
  readonly client: OperationsClient;
  readonly requests: OperationsRequestOptions[];
}

function captureClient(
  handler: (
    request: OperationsRequestOptions,
    index: number,
  ) => Promise<OperationsOverview>,
): CapturedClient {
  const requests: OperationsRequestOptions[] = [];
  const client: OperationsClient = {
    getOperations(request = {}) {
      requests.push(request);
      return handler(request, requests.length - 1);
    },
  };
  return { client, requests };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, resolve, reject };
}

interface FetchCall {
  readonly url: string;
  readonly method: string;
}

/** In-Memory-Server: nur GET; keine Backup-Prüfroute vorhanden. */
function createOperationsServer() {
  const calls: FetchCall[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method === "GET" && url.endsWith("/admin/registration-codes")) {
      return Promise.resolve(jsonResponse(200, { items: [] }));
    }
    if (method === "GET" && url.endsWith("/v1/admin/operations")) {
      return Promise.resolve(
        jsonResponse(200, {
          generated_at: "2026-11-16T05:00:00.000Z",
          readiness: {
            status: "ready",
            checked_at: "2026-11-16T04:59:00.000Z",
          },
          alarms: {
            available: true,
            reason: null,
            items: [
              {
                id: "alarm-live",
                at: "2026-11-16T04:30:00.000Z",
                action: "technical_alarm.episode.opened",
                episode_id: "episode-live",
                resource_id: "ressource-live",
                error_code: null,
                resolved_at: null,
                unknown_fields: ["error_code"],
              },
            ],
          },
          last_backup_check: {
            available: true,
            reason: null,
            proof: {
              event_id: "event-live",
              run_id: "live-lauf",
              started_at: "2026-11-16T03:59:00.000Z",
              finished_at: "2026-11-16T04:00:00.000Z",
              duration_ms: 60000,
              status: "succeeded",
              archive_sha256: "b".repeat(64),
              checks: {
                restore: true,
                content: true,
                foreign_keys: true,
                sequences: true,
                cleanup: true,
              },
              error_code: null,
              unknown_fields: [],
            },
          },
        }),
      );
    }
    return Promise.resolve(
      jsonResponse(404, { error: { code: "not_found" } }),
    );
  };
  return {
    fetchImpl,
    calls,
    operationsCalls() {
      return calls.filter((call) =>
        call.url.endsWith("/v1/admin/operations"),
      );
    },
  };
}

describe("CX-062 Lesende Betriebsseite", () => {
  it("öffnet die Betriebsseite über die Admin-Navigation und zeigt Readiness, höchstens 20 Alarme und den Backup-Nachweis mit Zeit und Status", async () => {
    const alarmItems = Array.from({ length: 25 }, (_unused, index) =>
      alarmItem({
        id: "alarm-" + String(index + 1),
        episodeId: "episode-" + String(index + 1),
        resourceId:
          index === 0 ? null : "ressource-" + String(index + 1),
        errorCode: index === 0 ? null : "code-" + String(index + 1),
        unknownFields:
          index === 0 ? ["resource_id", "error_code"] : [],
        resolvedAt:
          index % 2 === 0 ? null : "2026-11-16T04:30:00.000Z",
      }),
    );
    const captured = captureClient(async () =>
      overview({
        alarms: { available: true, reason: null, items: alarmItems },
        lastBackupCheck: {
          available: true,
          reason: null,
          proof: backupProof({
            runId: "backup-lauf-1",
            status: "succeeded",
            finishedAt: "2026-11-16T03:00:00.000Z",
          }),
        },
      }),
    );

    window.history.replaceState(null, "", "#/geraete");
    render(<App fetchImpl={sessionFetch} operationsClient={captured.client} />);
    await screen.findByRole("heading", { name: "Geräte" });

    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "Betrieb" }));
    await screen.findByRole("heading", { name: "Betrieb" });
    await waitFor(() => expect(captured.requests).toHaveLength(1));

    expect(
      screen.getByRole("link", { name: "Betrieb" }).getAttribute(
        "aria-current",
      ),
    ).toBe("page");

    const page = screen.getByRole("region", { name: "Betrieb" });
    const readiness = within(page).getByRole("region", {
      name: "Readiness",
    });
    expect(within(readiness).getByText("Bereit")).toBeTruthy();
    expect(
      within(readiness).getByText("2026-11-16T04:55:00.000Z"),
    ).toBeTruthy();

    const alarms = within(page).getByRole("region", {
      name: "Letzte technische Alarmereignisse",
    });
    // Kopfzeile plus genau 20 der 25 gelieferten Ereignisse.
    expect(within(alarms).getAllByRole("row")).toHaveLength(21);
    expect(within(alarms).getByText("episode-1")).toBeTruthy();
    expect(within(alarms).queryByText("episode-21")).toBeNull();
    expect(
      within(alarms).getByText("Unvollständig: resource_id, error_code"),
    ).toBeTruthy();

    const backup = within(page).getByRole("region", {
      name: "Letzter Backup-Nachweis",
    });
    expect(within(backup).getByText("backup-lauf-1")).toBeTruthy();
    expect(within(backup).getByText("Erfolgreich")).toBeTruthy();
    expect(
      within(backup).getByText("2026-11-16T03:00:00.000Z"),
    ).toBeTruthy();
  });

  it("zeigt leere Alarmliste und fehlenden Backup-Nachweis als noch nicht vorhanden, nicht als gesunden oder erfolgreichen Zustand", async () => {
    const captured = captureClient(async () =>
      overview({
        readiness: {
          status: "unknown",
          checkedAt: "2026-11-16T04:55:00.000Z",
        },
        alarms: { available: true, reason: null, items: [] },
        lastBackupCheck: {
          available: false,
          reason: "no_backup_check",
          proof: null,
        },
      }),
    );

    render(<OperationsPage client={captured.client} />);
    await screen.findByRole("region", { name: "Readiness" });

    const page = screen.getByRole("region", { name: "Betrieb" });
    const readiness = within(page).getByRole("region", {
      name: "Readiness",
    });
    expect(within(readiness).getByText("Unbekannt")).toBeTruthy();
    expect(within(readiness).queryByText("Bereit")).toBeNull();

    const alarms = within(page).getByRole("region", {
      name: "Letzte technische Alarmereignisse",
    });
    expect(
      within(alarms).getByText(
        "Noch keine technischen Alarmereignisse vorhanden.",
      ),
    ).toBeTruthy();
    expect(within(alarms).queryByRole("table")).toBeNull();

    const backup = within(page).getByRole("region", {
      name: "Letzter Backup-Nachweis",
    });
    expect(
      within(backup).getByText("Noch kein Backup-Nachweis vorhanden."),
    ).toBeTruthy();
    expect(within(backup).queryByText("Erfolgreich")).toBeNull();
    expect(within(backup).queryByText("Fehlgeschlagen")).toBeNull();
    expect(captured.requests).toHaveLength(1);
  });

  it("zeigt Ladefehler, partielle Nichtverfügbarkeit und fehlgeschlagenen Nachweis; eine verspätete Antwort überschreibt die neuere Anzeige nicht", async () => {
    const failing = captureClient(async () => {
      throw new AdminApiError(
        "network",
        "Der Server ist nicht erreichbar. Bitte die Verbindung prüfen.",
      );
    });
    const failedView = render(<OperationsPage client={failing.client} />);
    const loadAlert = await screen.findByRole("alert");
    expect(loadAlert.textContent).toContain(
      "Der Server ist nicht erreichbar.",
    );
    failedView.unmount();

    const gates = [
      deferred<OperationsOverview>(),
      deferred<OperationsOverview>(),
      deferred<OperationsOverview>(),
    ];
    const captured = captureClient(
      (_request, index) => gates[index]!.promise,
    );
    render(<OperationsPage client={captured.client} />);
    await waitFor(() => expect(captured.requests).toHaveLength(1));

    await act(async () => {
      gates[0]!.resolve(
        overview({
          readiness: {
            status: "not_ready",
            checkedAt: "2026-11-16T04:55:00.000Z",
          },
          alarms: {
            available: false,
            reason: "alarm_log_unavailable",
            items: [],
          },
          lastBackupCheck: {
            available: true,
            reason: null,
            proof: backupProof({
              runId: "fehlgeschlagener-lauf",
              status: "failed",
              errorCode: "restore_failed",
              checks: {
                restore: false,
                content: false,
                foreignKeys: null,
                sequences: null,
                cleanup: true,
              },
              finishedAt: "2026-11-16T03:00:00.000Z",
            }),
          },
        }),
      );
      await Promise.resolve();
    });
    await screen.findByText("fehlgeschlagener-lauf");

    const page = screen.getByRole("region", { name: "Betrieb" });
    expect(within(page).getByText("Nicht bereit")).toBeTruthy();
    const alarms = within(page).getByRole("region", {
      name: "Letzte technische Alarmereignisse",
    });
    expect(
      within(alarms).getByText(
        "Alarmprotokoll nicht verfügbar. Eine partielle Anzeige ist nicht möglich.",
      ),
    ).toBeTruthy();
    const backup = within(page).getByRole("region", {
      name: "Letzter Backup-Nachweis",
    });
    expect(within(backup).getByText("Fehlgeschlagen")).toBeTruthy();
    expect(within(backup).getByText("restore_failed")).toBeTruthy();

    const user = userEvent.setup();
    await user.click(within(screen.getByRole("region", { name: "Betrieb" })).getByRole("button", { name: "Aktualisieren" }));
    await waitFor(() => expect(captured.requests).toHaveLength(2));
    await user.click(within(screen.getByRole("region", { name: "Betrieb" })).getByRole("button", { name: "Aktualisieren" }));
    await waitFor(() => expect(captured.requests).toHaveLength(3));

    // Die zweite (neuere) Anfrage antwortet zuerst.
    await act(async () => {
      gates[2]!.resolve(
        overview({
          readiness: {
            status: "ready",
            checkedAt: "2026-11-16T05:00:00.000Z",
          },
          alarms: {
            available: true,
            reason: null,
            items: [
              alarmItem({
                id: "alarm-neu",
                episodeId: "episode-neu",
                resourceId: null,
                errorCode: null,
                unknownFields: ["resource_id", "error_code"],
              }),
            ],
          },
          lastBackupCheck: {
            available: true,
            reason: null,
            proof: backupProof({
              runId: "neuer-lauf",
              status: "incomplete",
              errorCode: "alarm_report_failed",
              unknownFields: ["run_id", "archive_sha256"],
            }),
          },
        }),
      );
      await Promise.resolve();
    });
    await screen.findByText("neuer-lauf");
    expect(screen.getByText("Unvollständig")).toBeTruthy();
    expect(
      screen.getByText(
        "Unvollständig protokolliert: run_id, archive_sha256",
      ),
    ).toBeTruthy();
    expect(screen.getByText("episode-neu")).toBeTruthy();

    // Die verspaetete aeltere Antwort darf die neuere Anzeige nicht ersetzen.
    await act(async () => {
      gates[1]!.resolve(
        overview({
          alarms: {
            available: true,
            reason: null,
            items: [
              alarmItem({
                id: "alarm-alt",
                episodeId: "episode-alt",
              }),
            ],
          },
          lastBackupCheck: {
            available: true,
            reason: null,
            proof: backupProof({
              runId: "veralteter-lauf",
              status: "succeeded",
            }),
          },
        }),
      );
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByText("veralteter-lauf")).toBeNull();
      expect(screen.queryByText("episode-alt")).toBeNull();
    });
    expect(screen.getByText("neuer-lauf")).toBeTruthy();
    expect(screen.getByText("episode-neu")).toBeTruthy();
  });

  it("sperrt Operatoren aus und verwendet beim Rendern und Aktualisieren ausschließlich den lesenden GET-Aufruf ohne Backup-Prüfung", async () => {
    window.history.replaceState(null, "", "#/betrieb");
    const operator = captureClient(async () => overview());
    const operatorView = render(
      <AdminShell fetchImpl={sessionFetch} role="Operator">
        <NavigationFrame
          operationsPage={<OperationsPage client={operator.client} />}
        />
      </AdminShell>,
    );
    await screen.findByRole("heading", { name: "Betrieb" });
    expect(screen.queryByRole("link", { name: "Betrieb" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "Kein Zugriff auf die Betriebsseite",
    );
    expect(operator.requests).toHaveLength(0);
    operatorView.unmount();

    window.history.replaceState(null, "", "#/betrieb");
    const net = createOperationsServer();
    render(<App fetchImpl={net.fetchImpl} />);
    await screen.findByRole("heading", { name: "Betrieb" });
    await waitFor(() => expect(net.operationsCalls()).toHaveLength(1));
    await screen.findByText("live-lauf");

    const user = userEvent.setup();
    await user.click(within(screen.getByRole("region", { name: "Betrieb" })).getByRole("button", { name: "Aktualisieren" }));
    await waitFor(() => expect(net.operationsCalls()).toHaveLength(2));

    // Nur der vorhandene lesende Client-Aufruf; kein POST, keine
    // Backup-Pruefung und keine andere Netzroute.
    expect(net.calls.every((call) => call.method === "GET")).toBe(true);
    expect(
      net.operationsCalls().every(
        (call) =>
          call.method === "GET" &&
          call.url.endsWith("/v1/admin/operations"),
      ),
    ).toBe(true);
    expect(
      net.calls.some((call) => call.url.includes("backup-check")),
    ).toBe(false);
    expect(screen.queryByRole("button", { name: /Backup/i })).toBeNull();
    expect(screen.getByText("live-lauf")).toBeTruthy();
  });
});
