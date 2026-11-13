import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";
import { AdminShell } from "../admin/AdminShell";
import type { AdminDevice, AdminDeviceDetail, FetchLike } from "../admin/adminApi";
import { DevicesPanel } from "./DevicesPanel";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

interface Call {
  path: string;
  method: string;
  body: string | null;
}

type Handler = (call: Call) => Response | Promise<Response>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function createServer(handler: Handler) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const path = String(input).replace(/^\/v1/, "");
    const call: Call = {
      path,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    return handler(call);
  };
  return {
    fetchImpl,
    calls,
    gets(path: string) {
      return calls.filter((call) => call.method === "GET" && call.path === path);
    },
    posts(path: string) {
      return calls.filter((call) => call.method === "POST" && call.path === path);
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function empty(status = 204): Response {
  return new Response(null, { status });
}

function unauthorized(): Response {
  return json(401, { error: { code: "unauthorized" } });
}

function device(overrides: Partial<AdminDevice> & { id: string }): AdminDevice {
  const { id: deviceId, ...rest } = overrides;
  return {
    id: deviceId,
    label: null,
    manufacturer: "Acme",
    model: "M1",
    osVersion: "14",
    sdkInt: 34,
    appVersion: "1.2.3",
    appFlavor: "prod",
    state: "active",
    registeredAt: "2026-11-01T10:00:00Z",
    lastSeenAt: "2026-11-13T08:00:00Z",
    connectivity: "reachable",
    ...rest,
  };
}

function detail(
  overrides: Partial<AdminDeviceDetail> & { id: string },
): AdminDeviceDetail {
  const { id: deviceId, ...rest } = overrides;
  return {
    ...device({ id: deviceId }),
    lastClockOffsetMs: 0,
    registrationCodeId: null,
    ...rest,
  };
}

function registrationCodes(handler: Handler): Handler {
  return (call) => {
    if (call.method === "GET" && call.path === "/admin/registration-codes") {
      return json(200, { items: [] });
    }
    return handler(call);
  };
}

function wireDevice(item: AdminDevice) {
  return {
    id: item.id,
    label: item.label,
    manufacturer: item.manufacturer,
    model: item.model,
    os_version: item.osVersion,
    sdk_int: item.sdkInt,
    app_version: item.appVersion,
    app_flavor: item.appFlavor,
    state: item.state,
    registered_at: item.registeredAt,
    last_seen_at: item.lastSeenAt,
    connectivity: item.connectivity,
  };
}

function wireDetail(item: AdminDeviceDetail) {
  return {
    ...wireDevice(item),
    last_clock_offset_ms: item.lastClockOffsetMs,
    registration_code_id: item.registrationCodeId,
  };
}

function listBody(
  items: AdminDevice[],
  options: { truncated?: boolean } = {},
): Response {
  return json(200, {
    server_time: "2026-11-13T08:00:00Z",
    online_threshold_s: 60,
    items: items.map(wireDevice),
    ...(options.truncated === undefined
      ? {}
      : { truncated: options.truncated }),
  });
}

describe("DevicesPanel", () => {
  it("zeigt ohne Sitzung keine Geräte und entfernt nach Abmeldung oder Geräte-401 beide Bereiche", async () => {
    const user = userEvent.setup();
    let authenticated = false;
    let devicesUnauthorized = false;

    const handler = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const path = String(input).replace(/^\/v1/, "");
      const method = init?.method ?? "GET";
      if (path === "/admin/login" && method === "POST") {
        authenticated = true;
        return empty(204);
      }
      if (path === "/admin/logout" && method === "POST") {
        authenticated = false;
        return empty(204);
      }
      if (path === "/admin/registration-codes" && method === "GET") {
        return authenticated
          ? json(200, { items: [] })
          : unauthorized();
      }
      if (path === "/admin/devices" && method === "GET") {
        if (!authenticated || devicesUnauthorized) {
          return unauthorized();
        }
        return listBody([device({ id: "gerät-1", label: "Testgerät" })]);
      }
      throw new Error(`Unerwarteter Aufruf: ${method} ${path}`);
    };
    globalThis.fetch = handler as typeof fetch;

    render(<App />);

    await screen.findByRole("heading", { name: "Anmeldung" });
    expect(screen.queryByRole("heading", { name: "Geräte" })).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Registrierungscodes" }),
    ).toBeNull();

    await user.type(screen.getByLabelText("Passwort"), "geheim");
    await user.click(screen.getByRole("button", { name: "Anmelden" }));

    await screen.findByRole("heading", { name: "Registrierungscodes" });
    await screen.findByRole("heading", { name: "Geräte" });
    await screen.findByText("gerät-1");

    devicesUnauthorized = true;
    await user.click(
      within(screen.getByRole("region", { name: "Geräte" })).getByRole(
        "button",
        { name: "Aktualisieren" },
      ),
    );

    await screen.findByRole("heading", { name: "Anmeldung" });
    expect(
      screen.queryByRole("heading", { name: "Registrierungscodes" }),
    ).toBeNull();
    expect(screen.queryByRole("heading", { name: "Geräte" })).toBeNull();

    devicesUnauthorized = false;
    await user.type(screen.getByLabelText("Passwort"), "geheim");
    await user.click(screen.getByRole("button", { name: "Anmelden" }));
    await screen.findByRole("heading", { name: "Registrierungscodes" });
    await screen.findByRole("heading", { name: "Geräte" });

    await user.click(screen.getByRole("button", { name: "Abmelden" }));
    await screen.findByRole("heading", { name: "Anmeldung" });
    expect(
      screen.queryByRole("heading", { name: "Registrierungscodes" }),
    ).toBeNull();
    expect(screen.queryByRole("heading", { name: "Geräte" })).toBeNull();
  });

  it("übernimmt Serverreihenfolge, Zustand und connectivity und unterscheidet leer, Fehler und truncated", async () => {
    const user = userEvent.setup();
    let stage: "truncated" | "empty" | "error" = "truncated";

    const server = createServer(
      registrationCodes((call) => {
        if (call.method !== "GET" || call.path !== "/admin/devices") {
          throw new Error(`Unerwarteter Aufruf: ${call.method} ${call.path}`);
        }
        if (stage === "error") {
          return json(500, { error: { code: "internal" } });
        }
        if (stage === "empty") {
          return listBody([], { truncated: false });
        }
        return listBody(
          [
            device({
              id: "dev-b",
              label: "Zweites",
              state: "revoked",
              connectivity: "last_seen",
            }),
            device({
              id: "dev-a",
              label: "Erstes",
              state: "active",
              connectivity: "reachable",
            }),
          ],
          { truncated: true },
        );
      }),
    );

    render(
      <AdminShell fetchImpl={server.fetchImpl}>
        <DevicesPanel />
      </AdminShell>,
    );

    await screen.findByText("dev-b");
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1]?.textContent ?? "").toContain("dev-b");
    expect(rows[2]?.textContent ?? "").toContain("dev-a");
    expect(within(table).getByText("Erreichbar")).toBeTruthy();
    expect(rows[1]?.textContent ?? "").toContain("Zuletzt gesehen");
    expect(within(table).getByText("Aktiv")).toBeTruthy();
    expect(within(table).getByText("Gesperrt")).toBeTruthy();
    expect(screen.getByText(/unvollständig/)).toBeTruthy();

    const refreshButton = () =>
      within(screen.getByRole("region", { name: "Geräte" })).getByRole(
        "button",
        { name: "Aktualisieren" },
      );

    stage = "empty";
    await user.click(refreshButton());
    await screen.findByText("Keine Geräte vorhanden.");
    expect(screen.queryByText(/unvollständig/)).toBeNull();

    stage = "error";
    await user.click(refreshButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").toContain(
      "Der Server hat einen Fehler gemeldet",
    );
    expect(screen.queryByText("Keine Geräte vorhanden.")).toBeNull();
  });

  it("lädt das passende Detail und lässt eine verspätete Antwort von A die Ansicht von B nicht überschreiben", async () => {
    const user = userEvent.setup();
    const pending = new Map<string, Deferred<Response>>();

    const server = createServer(
      registrationCodes((call) => {
        if (call.method === "GET" && call.path === "/admin/devices") {
          return listBody([device({ id: "dev-a" }), device({ id: "dev-b" })]);
        }
        if (call.method === "GET" && call.path.startsWith("/admin/devices/")) {
          const id = decodeURIComponent(
            call.path.slice("/admin/devices/".length),
          );
          const response = deferred<Response>();
          pending.set(id, response);
          return response.promise;
        }
        throw new Error(`Unerwarteter Aufruf: ${call.method} ${call.path}`);
      }),
    );

    render(
      <AdminShell fetchImpl={server.fetchImpl}>
        <DevicesPanel />
      </AdminShell>,
    );

    await screen.findByRole("button", { name: "Details zu dev-a" });
    await user.click(screen.getByRole("button", { name: "Details zu dev-a" }));
    await user.click(screen.getByRole("button", { name: "Details zu dev-b" }));

    const bResponse = pending.get("dev-b");
    expect(bResponse).toBeDefined();
    await act(async () => {
      bResponse?.resolve(
        json(
          200,
          wireDetail(detail({
            id: "dev-b",
            lastClockOffsetMs: 1234,
            registrationCodeId: "rc-b",
          })),
        ),
      );
    });

    await screen.findByText("1234 ms");
    expect(screen.getByText("rc-b")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Gerät dev-b" })).toBeTruthy();

    const aResponse = pending.get("dev-a");
    expect(aResponse).toBeDefined();
    await act(async () => {
      aResponse?.resolve(
        json(
          200,
          wireDetail(detail({
            id: "dev-a",
            lastClockOffsetMs: 9999,
            registrationCodeId: "rc-a",
          })),
        ),
      );
      await Promise.resolve();
    });

    expect(screen.queryByText("9999 ms")).toBeNull();
    expect(screen.queryByText("rc-a")).toBeNull();
    expect(screen.getByText("1234 ms")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Gerät dev-b" })).toBeTruthy();
  });

  it("sendet nach Bestätigung genau einen POST und lädt erst nach 204 neu; Fehler erzeugen keinen zweiten POST", async () => {
    const user = userEvent.setup();

    let revoked = false;
    let postResponse: Deferred<Response> | null = null;
    const server = createServer(
      registrationCodes((call) => {
        if (call.method === "GET" && call.path === "/admin/devices") {
          return listBody([
            device({ id: "dev-a", label: "Sperrgerät", state: revoked ? "revoked" : "active" }),
          ]);
        }
        if (
          call.method === "POST" &&
          call.path === "/admin/devices/dev-a/revoke"
        ) {
          postResponse = deferred<Response>();
          return postResponse.promise;
        }
        if (call.method === "GET" && call.path === "/admin/devices/dev-a") {
          return json(
            200,
            wireDetail(detail({
              id: "dev-a",
              label: "Sperrgerät",
              state: revoked ? "revoked" : "active",
              lastClockOffsetMs: 42,
              registrationCodeId: "rc-1",
            })),
          );
        }
        throw new Error(`Unerwarteter Aufruf: ${call.method} ${call.path}`);
      }),
    );

    render(
      <AdminShell fetchImpl={server.fetchImpl}>
        <DevicesPanel />
      </AdminShell>,
    );

    await screen.findByRole("button", { name: "Details zu dev-a" });
    await user.click(screen.getByRole("button", { name: "Details zu dev-a" }));
    await screen.findByText("42 ms");

    await user.click(screen.getByRole("button", { name: "Gerät sperren" }));
    let confirmation = screen.getByRole("group", {
      name: "Sperrbestätigung",
    });
    expect(confirmation.textContent ?? "").toContain("dev-a");

    await user.click(
      within(confirmation).getByRole("button", { name: "Abbrechen" }),
    );
    expect(
      server.posts("/admin/devices/dev-a/revoke"),
    ).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Gerät sperren" }));
    confirmation = screen.getByRole("group", { name: "Sperrbestätigung" });
    const confirmButton = within(confirmation).getByRole("button", {
      name: "Sperren bestätigen",
    });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    const posts = server.posts("/admin/devices/dev-a/revoke");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toBe("{}");
    expect(server.gets("/admin/devices")).toHaveLength(1);
    expect(server.gets("/admin/devices/dev-a")).toHaveLength(1);

    revoked = true;
    await act(async () => {
      postResponse?.resolve(empty(204));
    });

    await screen.findByText(/Gerät dev-a wurde vom Server gesperrt/);
    await waitFor(() => {
      expect(server.gets("/admin/devices")).toHaveLength(2);
      expect(server.gets("/admin/devices/dev-a")).toHaveLength(2);
    });
    expect(within(screen.getByRole("table")).getByText("Gesperrt")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Gerät sperren" })).toBeNull();
    expect(server.posts("/admin/devices/dev-a/revoke")).toHaveLength(1);

    cleanup();

    const failing = createServer(
      registrationCodes((call) => {
        if (call.method === "GET" && call.path === "/admin/devices") {
          return listBody([device({ id: "dev-e" })]);
        }
        if (call.method === "GET" && call.path === "/admin/devices/dev-e") {
          return json(
            200,
            wireDetail(detail({ id: "dev-e", lastClockOffsetMs: 7, registrationCodeId: null })),
          );
        }
        if (
          call.method === "POST" &&
          call.path === "/admin/devices/dev-e/revoke"
        ) {
          return json(500, { error: { code: "internal" } });
        }
        throw new Error(`Unerwarteter Aufruf: ${call.method} ${call.path}`);
      }),
    );

    render(
      <AdminShell fetchImpl={failing.fetchImpl}>
        <DevicesPanel />
      </AdminShell>,
    );

    await screen.findByRole("button", { name: "Details zu dev-e" });
    await user.click(screen.getByRole("button", { name: "Details zu dev-e" }));
    await screen.findByText("7 ms");
    await user.click(screen.getByRole("button", { name: "Gerät sperren" }));
    await user.click(
      screen.getByRole("button", { name: "Sperren bestätigen" }),
    );

    await screen.findByText(/Der Server hat einen Fehler gemeldet/);
    expect(screen.queryByText(/wurde vom Server gesperrt/)).toBeNull();
    expect(failing.posts("/admin/devices/dev-e/revoke")).toHaveLength(1);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(failing.posts("/admin/devices/dev-e/revoke")).toHaveLength(1);

    const listCallsBefore = failing.gets("/admin/devices").length;
    await user.click(
      within(screen.getByRole("region", { name: "Geräte" })).getByRole(
        "button",
        { name: "Aktualisieren" },
      ),
    );
    await waitFor(() => {
      expect(failing.gets("/admin/devices")).toHaveLength(listCallsBefore + 1);
    });
    expect(failing.posts("/admin/devices/dev-e/revoke")).toHaveLength(1);
  });
});

