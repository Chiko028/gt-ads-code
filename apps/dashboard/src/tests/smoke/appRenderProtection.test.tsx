// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App, PageErrorBoundary } from "../../App";
import type { FetchLike } from "../../admin/adminApi";

interface FetchCall {
  readonly method: string;
  readonly url: string;
}

interface NodeProcessLike {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): void;
  off(event: "unhandledRejection", listener: (reason: unknown) => void): void;
}

const nodeProcess = (globalThis as unknown as { process?: NodeProcessLike })
  .process;

const originalConsoleError = console.error;
const THROW_MESSAGE = "SYN-geheimer Renderfehler CX-064";
const THROW_STACK = "SYN_STACK_FRAME_CX064";

function isExpectedReactRenderDiagnostic(args: readonly unknown[]): boolean {
  if (args.length !== 4 || args[0] !== "%o\n\n%s\n\n%s\n") {
    return false;
  }
  const thrown = args[1];
  const componentNotice = args[2];
  const recoveryNotice = args[3];
  const expectedComponentNotices = [
    "The above error occurred in the <ThrowingChild> component.",
    "The above error occurred in the <CountingThrow> component.",
  ];
  return (
    thrown instanceof Error &&
    thrown.message === THROW_MESSAGE &&
    typeof componentNotice === "string" &&
    expectedComponentNotices.includes(componentNotice) &&
    recoveryNotice ===
      "React will try to recreate this component tree from scratch using the error boundary you provided, PageErrorBoundary."
  );
}

let consoleErrors: unknown[][] = [];
let unhandledRejections: unknown[] = [];

function recordUnhandledRejection(reason: unknown): void {
  unhandledRejections.push(reason);
}

beforeEach(() => {
  consoleErrors = [];
  unhandledRejections = [];
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args);
  };
  nodeProcess?.on("unhandledRejection", recordUnhandledRejection);
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  console.error = originalConsoleError;
  nodeProcess?.off("unhandledRejection", recordUnhandledRejection);
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");

  const unexpectedConsoleErrors = consoleErrors.filter(
    (args) => !isExpectedReactRenderDiagnostic(args),
  );
  expect(unexpectedConsoleErrors).toEqual([]);
  expect(unhandledRejections).toEqual([]);
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createFetchDouble(
  handler: (call: FetchCall) => Response | Promise<Response>,
) {
  const calls: FetchCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const call: FetchCall = { method: init?.method ?? "GET", url: input };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetchImpl };
}

function requestLines(calls: readonly FetchCall[]): string[] {
  return calls.map((call) => call.method + " " + call.url);
}

function ThrowingChild(): never {
  const error = new Error(THROW_MESSAGE);
  error.stack = "Error: " + THROW_MESSAGE + "\n    at " + THROW_STACK;
  throw error;
}

describe("R-802 Renderfehlerschutz im Dashboard-Rahmen", () => {
  it("zeigt für einen synthetisch angemeldeten Admin die echte Benutzerseite", async () => {
    window.history.replaceState(null, "", "/#/benutzer");
    const user = {
      id: "syn-user-cx064",
      username: "syn-benutzer",
      role: "Admin",
      status: "active",
    };
    const net = createFetchDouble((call) => {
      if (
        call.method === "GET" &&
        call.url === "/v1/admin/registration-codes"
      ) {
        return jsonResponse(200, { items: [] });
      }
      if (call.method === "GET" && call.url === "/v1/admin/operators") {
        return jsonResponse(200, { items: [user] });
      }
      throw new Error(
        "Unerwarteter Request: " + call.method + " " + call.url,
      );
    });

    render(<App fetchImpl={net.fetchImpl} />);

    expect(
      await screen.findByRole("heading", { name: "Benutzer" }),
    ).toBeTruthy();
    expect(await screen.findByText("syn-benutzer")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Benutzer" }).getAttribute(
        "aria-current",
      ),
    ).toBe("page");
    expect(requestLines(net.calls)).toEqual([
      "GET /v1/admin/registration-codes",
      "GET /v1/admin/operators",
    ]);
  });

  it("schützt eine anonyme Sitzung beim direkten Aufruf der Benutzerseite", async () => {
    window.history.replaceState(null, "", "/#/benutzer");
    const net = createFetchDouble((call) => {
      if (
        call.method === "GET" &&
        call.url === "/v1/admin/registration-codes"
      ) {
        return jsonResponse(401, { error: { code: "unauthorized" } });
      }
      throw new Error(
        "Unerwarteter Request: " + call.method + " " + call.url,
      );
    });

    render(<App fetchImpl={net.fetchImpl} />);

    expect(
      await screen.findByRole("heading", { name: "Anmeldung" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Benutzer" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("syn-benutzer")).toBeNull();
    expect(requestLines(net.calls)).toEqual([
      "GET /v1/admin/registration-codes",
    ]);
  });

  it("ersetzt einen werfenden Seiteninhalt durch eine allgemeine Fehlermeldung ohne Details", async () => {
    render(
      <PageErrorBoundary resetKey="benutzer">
        <ThrowingChild />
      </PageErrorBoundary>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Der Seiteninhalt konnte nicht angezeigt werden.",
    );
    expect(document.body.innerHTML).not.toContain(THROW_MESSAGE);
    expect(document.body.innerHTML).not.toContain(THROW_STACK);
  });

  it("setzt den Fehlerzustand nur beim Wechsel der Seitenkennung zurück", async () => {
    let attempts = 0;

    function CountingThrow(): never {
      attempts += 1;
      throw new Error(THROW_MESSAGE);
    }

    const view = render(
      <PageErrorBoundary resetKey="benutzer">
        <CountingThrow />
      </PageErrorBoundary>,
    );
    await screen.findByRole("alert");
    const attemptsAfterCatch = attempts;

    view.rerender(
      <PageErrorBoundary resetKey="benutzer">
        <CountingThrow />
      </PageErrorBoundary>,
    );
    expect(attempts).toBe(attemptsAfterCatch);
    expect(screen.getByRole("alert")).toBeTruthy();

    view.rerender(
      <PageErrorBoundary resetKey="statistik">
        <p>Gesunder Seiteninhalt</p>
      </PageErrorBoundary>,
    );
    expect(await screen.findByText("Gesunder Seiteninhalt")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(attempts).toBe(attemptsAfterCatch);
  });
});
