/**
 * CX-044 / R-304: React-Interaktion der lesenden Ausspielungs-Vorschau.
 *
 * Beide Faelle laufen ohne Netzverbindung gegen deterministische
 * Test-Doubles. Der vorhandene API-Client wird unveraendert verwendet.
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
import { AdminShell } from "../admin/AdminShell";
import type {
  FleetTaxi,
  FleetTransport,
  FleetTransportRequest,
} from "../fleet/fleetApi";
import { PlayoutPreviewPage } from "./PlayoutPreviewPage";

afterEach(() => {
  cleanup();
});

interface Call {
  readonly path: string;
  readonly method: string;
}

interface RecordedTransport {
  readonly transport: FleetTransport;
  readonly calls: Call[];
  count(method: string, path: string): number;
}

function createTransport(
  handler: (call: Call) => Response | Promise<Response>,
): RecordedTransport {
  const calls: Call[] = [];
  const transport: FleetTransport = async (request: FleetTransportRequest) => {
    const call: Call = { path: request.path, method: request.method };
    calls.push(call);
    return handler(call);
  };
  return {
    transport,
    calls,
    count(method: string, path: string) {
      return calls.filter(
        (call) => call.method === method && call.path === path,
      ).length;
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

/** Nur die Anmeldepruefung der AdminShell; die Seite nutzt den Transport. */
function shellFetch(): FetchLike {
  return async (input, init) => {
    const path = String(input).replace(/^\/v1/, "");
    const method = init?.method ?? "GET";
    if (path === "/admin/registration-codes" && method === "GET") {
      return json(200, { items: [] });
    }
    if (path === "/admin/logout" && method === "POST") {
      return empty();
    }
    throw new Error("Unerwarteter Shell-Aufruf: " + method + " " + path);
  };
}

function renderPreview(transport: FleetTransport) {
  return render(
    <AdminShell fetchImpl={shellFetch()}>
      <PlayoutPreviewPage transport={transport} />
    </AdminShell>,
  );
}

function wireTaxi(taxi: FleetTaxi): unknown {
  return {
    id: taxi.id,
    display_name: taxi.displayName,
    active: taxi.active,
    revision: taxi.revision,
    tablet_ids: [...taxi.tabletIds],
    group_ids: [...taxi.groupIds],
  };
}

function taxi(overrides: Partial<FleetTaxi> & { id: string }): FleetTaxi {
  const { id, ...rest } = overrides;
  return {
    id,
    displayName: "Taxi " + id,
    active: false,
    revision: 1,
    tabletIds: [null, null],
    groupIds: [],
    ...rest,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

const VERSION_A = "a".repeat(64);
const VERSION_B = "b".repeat(64);
const START = "2026-12-01T08:00:00.000Z";
const END = "2026-12-01T18:00:00.000Z";

const ENTRIES = [
  {
    media_id: "media-1",
    duration_ms: 15000,
    start_at: START,
    end_at: END,
  },
  {
    media_id: "media-2",
    duration_ms: 20000,
    start_at: START,
    end_at: END,
  },
  {
    media_id: "media-3",
    duration_ms: 30000,
    start_at: "2026-12-02T06:30:00.000Z",
    end_at: "2026-12-02T20:00:00.000Z",
  },
];

describe("CX-044 Ausspielungs-Vorschau", () => {
  it("wählt ein Taxi und zeigt Version, geordnete Einträge und Laufzeitfenster; die Seite enthält keine schreibende Aktion", async () => {
    const user = userEvent.setup();
    const server = createTransport((call) => {
      if (call.method === "GET" && call.path === "/v1/admin/taxis") {
        return json(200, {
          items: [wireTaxi(taxi({ id: "t-1", displayName: "Taxi Eins" }))],
        });
      }
      if (
        call.method === "GET" &&
        call.path === "/v1/admin/taxis/t-1/playout-preview"
      ) {
        return json(200, {
          taxi_id: "t-1",
          manifest_version: VERSION_A,
          entries: ENTRIES,
        });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderPreview(server.transport);

    const select = await screen.findByRole("combobox", { name: "Taxi" });
    await waitFor(() => {
      expect(
        (select as HTMLSelectElement).querySelectorAll("option").length,
      ).toBe(2);
    });
    await user.selectOptions(select, "t-1");

    expect(
      await screen.findByText(
        "Veröffentlichter Sollplan – nicht die bestätigte Wiedergabe auf dem Tablet.",
      ),
    ).toBeTruthy();
    expect(await screen.findByText(VERSION_A)).toBeTruthy();

    const table = screen.getByRole("table", {
      name: "Geordnete Einträge",
    });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(4);

    for (let index = 0; index < ENTRIES.length; index += 1) {
      const entry = ENTRIES[index];
      const row = rows[index + 1];
      expect(entry).toBeDefined();
      const rowText = (row?.textContent ?? "").replace(/\s+/g, " ");
      expect(rowText).toContain(entry?.media_id ?? "");
      expect(rowText).toContain(String(entry?.duration_ms) + " ms");
      expect(rowText).toContain(
        (entry?.start_at ?? "") + " – " + (entry?.end_at ?? ""),
      );
    }

    // Genau die vorhandene Lese- und Listenroute; keine schreibende Aktion,
    // kein Formular, kein Button und kein Videoplayer.
    expect(
      server.calls.every((call) => call.method === "GET"),
    ).toBe(true);
    expect(server.count("GET", "/v1/admin/taxis")).toBe(1);
    expect(
      server.count("GET", "/v1/admin/taxis/t-1/playout-preview"),
    ).toBe(1);
    const previewRegion = screen.getByRole("region", { name: "Ausspielung" });
    expect(within(previewRegion).queryByRole("button")).toBeNull();
    expect(within(previewRegion).queryByRole("form")).toBeNull();
  });

  it("zeigt bei der tatsaechlichen API-Leerantwort den Leerzustand statt eines Fehlers", async () => {
    const user = userEvent.setup();
    const server = createTransport((call) => {
      if (call.method === "GET" && call.path === "/v1/admin/taxis") {
        return json(200, {
          items: [wireTaxi(taxi({ id: "t-1", displayName: "Taxi Eins" }))],
        });
      }
      if (
        call.method === "GET" &&
        call.path === "/v1/admin/taxis/t-1/playout-preview"
      ) {
        // Tatsaechliche Leerantwort der API (siehe apps/api/src/http/playoutPreview.ts).
        return json(200, {
          taxi_id: "t-1",
          manifest_version: null,
          entries: [],
        });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderPreview(server.transport);

    const select = await screen.findByRole("combobox", { name: "Taxi" });
    await waitFor(() => {
      expect(
        (select as HTMLSelectElement).querySelectorAll("option").length,
      ).toBe(2);
    });
    await user.selectOptions(select, "t-1");

    expect(
      await screen.findByText("Noch kein veröffentlichtes Manifest."),
    ).toBeTruthy();
    // Kein Fehlerzustand: weder Alarm noch Fehlertext.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByText(/ungültige Antwort|Ungültige Antwort/),
    ).toBeNull();
    expect(
      screen.queryByRole("table", { name: "Geordnete Einträge" }),
    ).toBeNull();
    expect(
      server.count("GET", "/v1/admin/taxis/t-1/playout-preview"),
    ).toBe(1);
  });

  it("zeigt einen Ladefehler und lässt eine verspätete Antwort des vorherigen Taxis die aktuelle Auswahl nicht überschreiben", async () => {
    const user = userEvent.setup();
    const pendingA: Array<Deferred<Response>> = [];
    let modeA: "error" | "slow" | "ok" = "error";

    const previewA = {
      taxi_id: "t-a",
      manifest_version: VERSION_A,
      entries: [
        {
          media_id: "a-media",
          duration_ms: 11000,
          start_at: START,
          end_at: END,
        },
      ],
    };
    const previewB = {
      taxi_id: "t-b",
      manifest_version: VERSION_B,
      entries: [
        {
          media_id: "b-media",
          duration_ms: 22000,
          start_at: START,
          end_at: END,
        },
      ],
    };

    const server = createTransport((call) => {
      if (call.method === "GET" && call.path === "/v1/admin/taxis") {
        return json(200, {
          items: [
            wireTaxi(taxi({ id: "t-a", displayName: "Taxi A" })),
            wireTaxi(taxi({ id: "t-b", displayName: "Taxi B" })),
          ],
        });
      }
      if (call.method === "GET" && call.path === "/v1/admin/taxis/t-a/playout-preview") {
        if (modeA === "error") {
          return json(500, { error: { code: "server_error" } });
        }
        if (modeA === "slow") {
          const gate = deferred<Response>();
          pendingA.push(gate);
          return gate.promise;
        }
        return json(200, previewA);
      }
      if (call.method === "GET" && call.path === "/v1/admin/taxis/t-b/playout-preview") {
        return json(200, previewB);
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderPreview(server.transport);

    const select = await screen.findByRole("combobox", { name: "Taxi" });
    await waitFor(() => {
      expect(
        (select as HTMLSelectElement).querySelectorAll("option").length,
      ).toBe(3);
    });

    // 1. Ladefehler des ersten Abrufs ist sichtbar.
    await user.selectOptions(select, "t-a");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").toContain("Server hat einen Fehler gemeldet");

    // 2. Schneller Wechsel: A ist verspaetet, B antwortet sofort.
    await user.selectOptions(select, "t-b");
    expect(await screen.findByText(VERSION_B)).toBeTruthy();

    modeA = "slow";
    await user.selectOptions(select, "t-a");
    await user.selectOptions(select, "t-b");

    expect(await screen.findByText(VERSION_B)).toBeTruthy();
    expect(pendingA).toHaveLength(1);

    // Die verspaetete Antwort von A trifft erst nach dem Wechsel ein.
    await act(async () => {
      pendingA[0]?.resolve(json(200, previewA));
      await Promise.resolve();
    });

    expect(screen.getByText(VERSION_B)).toBeTruthy();
    expect(screen.queryByText(VERSION_A)).toBeNull();
    expect(screen.getByText("b-media")).toBeTruthy();
    expect(screen.queryByText("a-media")).toBeNull();
    expect(
      server.calls.every((call) => call.method === "GET"),
    ).toBe(true);
  });
});

