import {
  act,
  cleanup,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { FleetInventoryItem } from "./fleetApi";
import {
  createTransport,
  inventoryItem,
  json,
  PATHS,
  renderFleet,
  wireInventory,
} from "./fleetTestSupport";

afterEach(() => {
  cleanup();
});

/** Cursor der zweiten Seite; der Endpunkt liefert genau diese Kennung. */
const NEXT_CURSOR = "11111111-2222-4333-8444-555555555555";
const PAGE_TWO_PATH = PATHS.inventory + "?after=" + NEXT_CURSOR;

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

function isListPath(path: string): boolean {
  return (
    path === PATHS.taxis ||
    path === PATHS.groups ||
    path === PATHS.tablets
  );
}

function inventoryRow(deviceId: string): HTMLTableRowElement {
  const region = screen.getByRole("region", { name: "Inventar" });
  const table = within(region).getByRole("table");
  const row = within(table).getByText(deviceId).closest("tr");
  if (row === null) {
    throw new Error("Zeile fehlt: " + deviceId);
  }
  return row;
}

describe("CX-142 Inventarliste", () => {
  it("zeigt Seriennummer, Gerätetyp und Austauschvermerk als Text und fehlende Werte als nicht hinterlegt", async () => {
    const items: FleetInventoryItem[] = [
      inventoryItem({
        deviceId: "d-1",
        serialNumber: "<b>SN-1</b>",
        deviceType: "Tablet X",
        replacementNote: "Tausch A",
        revision: 3,
      }),
      inventoryItem({ deviceId: "d-2" }),
    ];
    const server = createTransport((call) => {
      if (call.method === "GET" && call.path === PATHS.inventory) {
        return json(200, { items: items.map(wireInventory) });
      }
      if (call.method === "GET" && isListPath(call.path)) {
        return json(200, { items: [] });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);
    await screen.findByText("d-1");

    const filled = inventoryRow("d-1");
    const serialCell = filled.children[1];
    expect(serialCell?.textContent).toBe("<b>SN-1</b>");
    expect(serialCell?.querySelector("b")).toBeNull();
    expect(filled.children[2]?.textContent).toBe("Tablet X");
    expect(filled.children[3]?.textContent).toBe("Tausch A");

    const missing = inventoryRow("d-2");
    expect(missing.children[1]?.textContent).toBe("nicht hinterlegt");
    expect(missing.children[2]?.textContent).toBe("nicht hinterlegt");
    expect(missing.children[3]?.textContent).toBe("nicht hinterlegt");
  });

  it("wechselt über den after-Cursor und zeigt keine vermischten Seiten", async () => {
    const user = userEvent.setup();
    const pageOne = [
      inventoryItem({ deviceId: "d-1" }),
      inventoryItem({ deviceId: "d-2" }),
    ];
    const pageTwo = [inventoryItem({ deviceId: "d-3" })];
    const server = createTransport((call) => {
      if (call.method === "GET" && call.path === PATHS.inventory) {
        return json(200, {
          items: pageOne.map(wireInventory),
          nextCursor: NEXT_CURSOR,
        });
      }
      if (call.method === "GET" && call.path === PAGE_TWO_PATH) {
        return json(200, { items: pageTwo.map(wireInventory) });
      }
      if (call.method === "GET" && isListPath(call.path)) {
        return json(200, { items: [] });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);
    await screen.findByText("d-1");

    await user.click(screen.getByRole("button", { name: "Nächste Seite" }));
    await screen.findByText("d-3");
    expect(screen.queryByText("d-1")).toBeNull();
    expect(screen.queryByText("d-2")).toBeNull();
    expect(server.count("GET", PAGE_TWO_PATH)).toBe(1);

    await user.click(screen.getByRole("button", { name: "Vorherige Seite" }));
    await screen.findByText("d-1");
    expect(screen.queryByText("d-3")).toBeNull();
    expect(server.count("GET", PATHS.inventory)).toBe(2);
  });

  it("verwirft die verspätete Antwort einer zuvor angefragten Seite", async () => {
    const user = userEvent.setup();
    const pageOne = [inventoryItem({ deviceId: "d-1" })];
    const pageTwo = [inventoryItem({ deviceId: "d-3" })];
    const pendingSecondPage = deferred<Response>();
    const server = createTransport((call) => {
      if (call.method === "GET" && call.path === PATHS.inventory) {
        return json(200, {
          items: pageOne.map(wireInventory),
          nextCursor: NEXT_CURSOR,
        });
      }
      if (call.method === "GET" && call.path === PAGE_TWO_PATH) {
        return pendingSecondPage.promise;
      }
      if (call.method === "GET" && isListPath(call.path)) {
        return json(200, { items: [] });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);
    await screen.findByText("d-1");

    await user.click(screen.getByRole("button", { name: "Nächste Seite" }));
    expect(screen.getByText("Inventar wird geladen …")).toBeTruthy();

    // Die erste Seite wird erneut angefragt und ist schneller als Seite zwei.
    await user.click(screen.getByRole("button", { name: "Vorherige Seite" }));
    await screen.findByText("d-1");

    await act(async () => {
      pendingSecondPage.resolve(
        json(200, { items: pageTwo.map(wireInventory) }),
      );
      await Promise.resolve();
    });

    expect(screen.getByText("d-1")).toBeTruthy();
    expect(screen.queryByText("d-3")).toBeNull();
    expect(
      screen.queryByText("Inventar wird geladen …"),
    ).toBeNull();
  });

  it("unterscheidet Lade-, Leer- und Fehlerzustand und wiederholt die aktuelle Seite", async () => {
    const user = userEvent.setup();
    const firstPage = deferred<Response>();
    const retriedPage = deferred<Response>();
    let inventoryCalls = 0;
    const server = createTransport((call) => {
      if (call.method === "GET" && call.path === PATHS.inventory) {
        inventoryCalls += 1;
        if (inventoryCalls === 1) {
          return firstPage.promise;
        }
        if (inventoryCalls === 2) {
          return json(500, { error: { code: "server_error" } });
        }
        return retriedPage.promise;
      }
      if (call.method === "GET" && isListPath(call.path)) {
        return json(200, { items: [] });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);
    await screen.findByRole("region", { name: "Inventar" });
    await screen.findByText("Inventar wird geladen …");

    await act(async () => {
      firstPage.resolve(json(200, { items: [] }));
      await Promise.resolve();
    });
    await screen.findByText("Keine Geräte im Inventar.");
    expect(screen.queryByRole("alert")).toBeNull();

    await user.click(
      within(screen.getByRole("region", { name: "Taxis" })).getByRole("button", {
        name: "Aktualisieren",
      }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").toContain("Server");
    expect(screen.queryByText("Keine Geräte im Inventar.")).toBeNull();

    await user.click(
      within(screen.getByRole("region", { name: "Inventar" })).getByRole("button", {
        name: "Inventar erneut laden",
      }),
    );
    await screen.findByText("Inventar wird geladen …");
    expect(inventoryCalls).toBe(3);

    await act(async () => {
      retriedPage.resolve(
        json(200, {
          items: [
            wireInventory(
              inventoryItem({ deviceId: "d-9", serialNumber: "SN-9" }),
            ),
          ],
        }),
      );
      await Promise.resolve();
    });
    await screen.findByText("d-9");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});