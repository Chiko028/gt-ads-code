import { act } from "react";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { FetchLike } from "../admin/adminApi";
import { App } from "../App";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

interface FetchCall {
  url: string;
  method: string;
}

type Handler = () => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

function deviceListBody() {
  return {
    server_time: "2026-11-13T10:00:00.000Z",
    online_threshold_s: 120,
    items: [],
    truncated: false,
  };
}

function userItem(
  id: string,
  username: string,
  role: string,
  status: string,
) {
  return { operator_id: id, username, role, status };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, resolve, reject };
}

function createServer(
  options: {
    authenticated?: boolean;
    codesStatus?: number;
  } = {},
) {
  let authenticated = options.authenticated ?? true;
  let usersHandler: Handler | null = null;
  const calls: FetchCall[] = [];

  const fetchImpl: FetchLike = (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });

    if (method === "POST" && url.endsWith("/admin/login")) {
      authenticated = true;
      return Promise.resolve(emptyResponse());
    }
    if (method === "POST" && url.endsWith("/admin/logout")) {
      authenticated = false;
      return Promise.resolve(emptyResponse());
    }
    if (method === "GET" && url.endsWith("/admin/registration-codes")) {
      if (options.codesStatus !== undefined && options.codesStatus !== 200) {
        return Promise.resolve(
          jsonResponse(options.codesStatus, { error: { code: "forbidden" } }),
        );
      }
      if (!authenticated) {
        return Promise.resolve(
          jsonResponse(401, { error: { code: "unauthorized" } }),
        );
      }
      return Promise.resolve(jsonResponse(200, { items: [] }));
    }
    if (!authenticated) {
      return Promise.resolve(
        jsonResponse(401, { error: { code: "unauthorized" } }),
      );
    }
    if (method === "GET" && url.endsWith("/admin/devices")) {
      return Promise.resolve(jsonResponse(200, deviceListBody()));
    }
    if (method === "GET" && url.endsWith("/admin/operators")) {
      return usersHandler === null
        ? Promise.resolve(jsonResponse(200, { items: [] }))
        : usersHandler();
    }
    return Promise.resolve(
      jsonResponse(404, { error: { code: "not_found" } }),
    );
  };

  return {
    fetchImpl,
    calls,
    setUsersHandler(handler: Handler) {
      usersHandler = handler;
    },
    usersCalls() {
      return calls.filter(
        (call) =>
          call.method === "GET" && call.url.endsWith("/admin/operators"),
      );
    },
  };
}

async function openUsers(
  net: ReturnType<typeof createServer>,
  user: ReturnType<typeof userEvent.setup>,
) {
  render(<App fetchImpl={net.fetchImpl} />);
  await screen.findByRole("heading", { name: "Geräte" });
  await user.click(screen.getByRole("link", { name: "Benutzer" }));
  await screen.findByRole("heading", { name: "Benutzer" });
}

describe("CX-059 Benutzerliste", () => {
  it("zeigt als bestätigter Admin Kennung, Rolle und Status ohne Geheimnisse und nutzt genau den lesenden Abruf", async () => {
    const net = createServer();
    const gate = deferred<Response>();
    net.setUsersHandler(() => gate.promise);
    const user = userEvent.setup();

    await openUsers(net, user);
    expect(screen.getByText("Benutzerliste wird geladen …")).toBeTruthy();

    await act(async () => {
      gate.resolve(
        jsonResponse(200, {
          items: [
            userItem("op-1", "anna", "Operator", "active"),
            userItem("op-2", "bert", "Admin", "disabled"),
          ],
        }),
      );
      await Promise.resolve();
    });

    expect(await screen.findByText("anna")).toBeTruthy();
    expect(screen.getByText("bert")).toBeTruthy();
    expect(screen.getByText("Operator")).toBeTruthy();
    expect(screen.getByText("Admin")).toBeTruthy();
    expect(screen.getByText("Aktiv")).toBeTruthy();
    expect(screen.getByText("Gesperrt")).toBeTruthy();
    expect(screen.queryByText(/passwort|password|hash/i)).toBeNull();

    const calls = net.usersCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(
      net.calls.some(
        (call) =>
          call.url.includes("/admin/operators") && call.method !== "GET",
      ),
    ).toBe(false);
  });

  it("zeigt den Leerzustand, entfernt Daten beim Aktualisieren sofort, meldet Fehler ohne alte Liste und verwirft überholte Ergebnisse", async () => {
    const net = createServer();
    let mode: "list" | "empty" | "error" | "pending" = "list";
    const emptyGate = deferred<Response>();
    const errorGate = deferred<Response>();
    const firstOverlap = deferred<Response>();
    const secondOverlap = deferred<Response>();
    let pendingCalls = 0;
    net.setUsersHandler(() => {
      if (mode === "empty") return emptyGate.promise;
      if (mode === "error") return errorGate.promise;
      if (mode === "pending") {
        pendingCalls += 1;
        return pendingCalls === 1 ? firstOverlap.promise : secondOverlap.promise;
      }
      return Promise.resolve(
        jsonResponse(200, {
          items: [userItem("op-1", "anna", "Operator", "active")],
        }),
      );
    });
    const user = userEvent.setup();

    await openUsers(net, user);
    expect(await screen.findByText("anna")).toBeTruthy();

    mode = "empty";
    await user.click(within(screen.getByRole("region", { name: "Benutzer" })).getByRole("button", { name: "Aktualisieren" }));
    expect(screen.queryByText("anna")).toBeNull();
    expect(screen.getByText("Benutzerliste wird geladen …")).toBeTruthy();
    await act(async () => {
      emptyGate.resolve(jsonResponse(200, { items: [] }));
      await Promise.resolve();
    });
    expect(await screen.findByText("Keine Benutzer vorhanden.")).toBeTruthy();

    mode = "error";
    await user.click(within(screen.getByRole("region", { name: "Benutzer" })).getByRole("button", { name: "Aktualisieren" }));
    expect(screen.queryByText("Keine Benutzer vorhanden.")).toBeNull();
    await act(async () => {
      errorGate.resolve(
        jsonResponse(500, { error: { code: "internal" } }),
      );
      await Promise.resolve();
    });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("anna")).toBeNull();

    mode = "pending";
    await user.click(within(screen.getByRole("region", { name: "Benutzer" })).getByRole("button", { name: "Aktualisieren" }));
    await user.click(within(screen.getByRole("region", { name: "Benutzer" })).getByRole("button", { name: "Aktualisieren" }));
    await waitFor(() => expect(net.usersCalls()).toHaveLength(5));

    await act(async () => {
      secondOverlap.resolve(
        jsonResponse(200, {
          items: [userItem("op-3", "neu", "Operator", "active")],
        }),
      );
      await Promise.resolve();
    });
    expect(await screen.findByText("neu")).toBeTruthy();

    await act(async () => {
      firstOverlap.resolve(
        jsonResponse(200, {
          items: [userItem("op-4", "alt", "Operator", "active")],
        }),
      );
      await Promise.resolve();
    });
    expect(screen.queryByText("alt")).toBeNull();
    expect(screen.getByText("neu")).toBeTruthy();
  });

  it("fragt ohne bestätigten Admin nicht ab und behandelt 403 sowie 401 der aktuellen Sitzung", async () => {
    const anonymous = createServer({ authenticated: false });
    render(<App fetchImpl={anonymous.fetchImpl} />);
    await screen.findByRole("heading", { name: "Anmeldung" });
    expect(anonymous.usersCalls()).toHaveLength(0);
    expect(screen.queryByRole("navigation")).toBeNull();
    cleanup();

    const operator = createServer({ codesStatus: 403 });
    render(<App fetchImpl={operator.fetchImpl} />);
    expect(
      await screen.findByText("Die Aktion ist nicht erlaubt."),
    ).toBeTruthy();
    expect(operator.usersCalls()).toHaveLength(0);
    expect(screen.queryByRole("navigation")).toBeNull();
    cleanup();

    const net = createServer();
    let phase: "list" | "forbidden" | "unauthorized" = "list";
    net.setUsersHandler(() =>
      phase === "forbidden"
        ? Promise.resolve(jsonResponse(403, { error: { code: "forbidden" } }))
        : phase === "unauthorized"
          ? Promise.resolve(
              jsonResponse(401, { error: { code: "unauthorized" } }),
            )
          : Promise.resolve(
              jsonResponse(200, {
                items: [userItem("op-1", "anna", "Operator", "active")],
              }),
            ),
    );
    const user = userEvent.setup();
    await openUsers(net, user);
    expect(await screen.findByText("anna")).toBeTruthy();

    phase = "forbidden";
    await user.click(within(screen.getByRole("region", { name: "Benutzer" })).getByRole("button", { name: "Aktualisieren" }));
    expect(await screen.findByText("Zugriff verweigert.")).toBeTruthy();
    expect(screen.queryByText("anna")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();

    phase = "unauthorized";
    await user.click(within(screen.getByRole("region", { name: "Benutzer" })).getByRole("button", { name: "Aktualisieren" }));
    await screen.findByRole("heading", { name: "Anmeldung" });
    expect(screen.queryByText("anna")).toBeNull();
  });

  it("entfernt Daten bei Logout sofort und macht späte Abschlüsse nach erneuter Anmeldung und Unmount wirkungslos", async () => {
    const net = createServer();
    const oldGate = deferred<Response>();
    const freshGate = deferred<Response>();
    const lateGate = deferred<Response>();
    let call = 0;
    net.setUsersHandler(() => {
      call += 1;
      if (call === 1) return oldGate.promise;
      if (call === 2) return freshGate.promise;
      return lateGate.promise;
    });
    const user = userEvent.setup();

    await openUsers(net, user);
    expect(screen.getByText("Benutzerliste wird geladen …")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Abmelden" }));
    await screen.findByRole("heading", { name: "Anmeldung" });
    expect(screen.queryByRole("heading", { name: "Benutzer" })).toBeNull();
    expect(screen.queryByText("Benutzerliste wird geladen …")).toBeNull();

    await user.type(screen.getByLabelText("Passwort"), "geheim");
    await user.click(screen.getByRole("button", { name: "Anmelden" }));
    await screen.findByRole("heading", { name: "Benutzer" });
    await waitFor(() => expect(net.usersCalls()).toHaveLength(2));

    await act(async () => {
      oldGate.resolve(
        jsonResponse(401, { error: { code: "unauthorized" } }),
      );
      await Promise.resolve();
    });
    expect(screen.queryByRole("heading", { name: "Anmeldung" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Benutzer" })).toBeTruthy();

    await act(async () => {
      freshGate.resolve(
        jsonResponse(200, {
          items: [userItem("op-2", "neu", "Operator", "active")],
        }),
      );
      await Promise.resolve();
    });
    expect(await screen.findByText("neu")).toBeTruthy();

    await user.click(within(screen.getByRole("region", { name: "Benutzer" })).getByRole("button", { name: "Aktualisieren" }));
    await waitFor(() => expect(net.usersCalls()).toHaveLength(3));
    await user.click(screen.getByRole("link", { name: "Geräte" }));
    await screen.findByRole("heading", { name: "Geräte" });

    await act(async () => {
      lateGate.resolve(
        jsonResponse(401, { error: { code: "unauthorized" } }),
      );
      await Promise.resolve();
    });
    expect(screen.queryByRole("heading", { name: "Anmeldung" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Geräte" })).toBeTruthy();
    expect(screen.queryByText("neu")).toBeNull();
  });
});
