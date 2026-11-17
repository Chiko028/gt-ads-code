import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { AdminShell } from "../admin/AdminShell";
import type { FleetInventoryItem } from "./fleetApi";
import { CONFLICT_MESSAGE } from "./fleetApi";
import { FleetPage } from "./FleetPage";
import {
  type Call,
  createTransport,
  inventoryItem,
  json,
  PATHS,
  renderFleet,
  shellFetch,
  wireInventory,
} from "./fleetTestSupport";

afterEach(() => {
  cleanup();
});

function otherLists(call: Call): Response | null {
  if (call.method === "GET" && (call.path === PATHS.taxis || call.path === PATHS.groups || call.path === PATHS.tablets)) {
    return json(200, { items: [] });
  }
  return null;
}

function inventoryRegion(): HTMLElement {
  return screen.getByRole("region", { name: "Inventar" });
}

function rowOf(deviceId: string): HTMLElement {
  return within(inventoryRegion()).getByRole("cell", { name: deviceId }).closest("tr") as HTMLElement;
}

function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

async function openEditor(user: ReturnType<typeof userEvent.setup>, deviceId: string): Promise<void> {
  await within(await screen.findByRole("region", { name: "Inventar" })).findByRole("cell", { name: deviceId });
  await user.click(within(rowOf(deviceId)).getByRole("button", { name: "Bearbeiten" }));
  await screen.findByRole("heading", { name: "Inventar " + deviceId });
}

async function fill(user: ReturnType<typeof userEvent.setup>, serial: string, type: string, note: string): Promise<void> {
  for (const [label, value] of [["Seriennummer", serial], ["Gerätetyp", type], ["Austauschvermerk", note]] as const) {
    await user.clear(field(label));
    await user.type(field(label), value);
  }
}

describe("CX-143 Inventardatensatz bearbeiten", () => {
  it("sendet die drei Felder mit Revision genau fuer das ausgewaehlte Tablet und zeigt die bestaetigten Daten", async () => {
    const user = userEvent.setup();
    const items: FleetInventoryItem[] = [
      inventoryItem({ deviceId: "d-1", serialNumber: "SN-1", revision: 3 }),
      inventoryItem({ deviceId: "d-2", serialNumber: "SN-2", revision: 8 }),
    ];
    const server = createTransport((call) => {
      const other = otherLists(call);
      if (other !== null) {
        return other;
      }
      if (call.method === "GET" && call.path === PATHS.inventory) {
        return json(200, { items: items.map(wireInventory) });
      }
      if (call.method === "PATCH" && call.path === PATHS.inventoryItem("d-2")) {
        const saved = inventoryItem({ deviceId: "d-2", serialNumber: "SN-2B", deviceType: "Tab A9", replacementNote: "Ersatz 11/2026", revision: 9 });
        return json(200, wireInventory(saved));
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);
    await openEditor(user, "d-2");
    expect(field("Seriennummer").value).toBe("SN-2");
    await fill(user, "SN-2B", "Tab A9", "Ersatz 11/2026");
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    await screen.findByText("Inventardaten gespeichert.");
    expect(server.bodyOf("PATCH", PATHS.inventoryItem("d-2"))).toEqual({
      serial_number: "SN-2B",
      device_type: "Tab A9",
      replacement_note: "Ersatz 11/2026",
      revision: 8,
    });
    expect(server.calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
    expect(within(rowOf("d-2")).getByText("Tab A9")).toBeTruthy();
    expect(within(rowOf("d-1")).getByText("SN-1")).toBeTruthy();
  });

  it("verwirft beim Abbrechen ohne Anfrage und sperrt erneutes Absenden waehrend des Speicherns", async () => {
    const user = userEvent.setup();
    let release: (response: Response) => void = () => undefined;
    const item = inventoryItem({ deviceId: "d-1", serialNumber: "SN-1", revision: 2 });
    const server = createTransport((call) => {
      const other = otherLists(call);
      if (other !== null) {
        return other;
      }
      if (call.method === "GET" && call.path === PATHS.inventory) {
        return json(200, { items: [wireInventory(item)] });
      }
      if (call.method === "PATCH" && call.path === PATHS.inventoryItem("d-1")) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);
    await openEditor(user, "d-1");
    await fill(user, "VERWORFEN", "x", "y");
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByRole("heading", { name: "Inventar d-1" })).toBeNull();
    expect(within(rowOf("d-1")).getByText("SN-1")).toBeTruthy();
    expect(server.calls.filter((call) => call.method === "PATCH")).toHaveLength(0);

    await openEditor(user, "d-1");
    expect(field("Seriennummer").value).toBe("SN-1");
    await user.clear(field("Seriennummer"));
    await user.type(field("Seriennummer"), "SN-NEU");
    const save = screen.getByRole("button", { name: "Speichern" }) as HTMLButtonElement;
    await user.click(save);
    await user.click(save);
    await waitFor(() => expect(save.disabled).toBe(true));
    expect(server.count("PATCH", PATHS.inventoryItem("d-1"))).toBe(1);

    release(json(200, wireInventory({ ...item, serialNumber: "SN-NEU", revision: 3 })));
    await screen.findByText("Inventardaten gespeichert.");
    expect(server.count("PATCH", PATHS.inventoryItem("d-1"))).toBe(1);
  });

  it("erhaelt bei Revisionskonflikt die Eingaben und laedt erst nach Bestaetigung neu", async () => {
    const user = userEvent.setup();
    let serverItem = inventoryItem({ deviceId: "d-1", serialNumber: "SN-ALT", revision: 4 });
    const server = createTransport((call) => {
      const other = otherLists(call);
      if (other !== null) {
        return other;
      }
      if (call.method === "GET" && call.path === PATHS.inventory) {
        return json(200, { items: [wireInventory(serverItem)] });
      }
      if (call.method === "PATCH" && call.path === PATHS.inventoryItem("d-1")) {
        return json(409, { error: { code: "revision_conflict" } });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);
    await openEditor(user, "d-1");
    await fill(user, "SN-MEIN", "Typ", "Notiz");
    serverItem = inventoryItem({ deviceId: "d-1", serialNumber: "SN-FREMD", revision: 5 });
    const loads = server.count("GET", PATHS.inventory);
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(CONFLICT_MESSAGE));
    expect(field("Seriennummer").value).toBe("SN-MEIN");
    expect(field("Austauschvermerk").value).toBe("Notiz");
    expect(server.count("PATCH", PATHS.inventoryItem("d-1"))).toBe(1);
    expect(server.count("GET", PATHS.inventory)).toBe(loads);

    const conflict = screen.getByRole("region", { name: "Inventarkonflikt" });
    await user.click(within(conflict).getByRole("button", { name: "Serverstand neu laden" }));
    await user.click(within(conflict).getByRole("button", { name: "Entwurf behalten" }));
    expect(field("Seriennummer").value).toBe("SN-MEIN");
    expect(server.count("GET", PATHS.inventory)).toBe(loads);

    await user.click(within(conflict).getByRole("button", { name: "Serverstand neu laden" }));
    await user.click(within(conflict).getByRole("button", { name: "Entwurf verwerfen und neu laden" }));
    await waitFor(() => expect(within(rowOf("d-1")).getByText("SN-FREMD")).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "Inventar d-1" })).toBeNull();
    expect(server.count("PATCH", PATHS.inventoryItem("d-1"))).toBe(1);
  });

  it("zeigt Validierungsfehler verstaendlich an und bietet einer lesenden Rolle keinen Bearbeitungsmodus", async () => {
    const user = userEvent.setup();
    const item = inventoryItem({ deviceId: "d-1", serialNumber: "SN-1", revision: 1 });
    const server = createTransport((call) => {
      const other = otherLists(call);
      if (other !== null) {
        return other;
      }
      if (call.method === "GET" && call.path === PATHS.inventory) {
        return json(200, { items: [wireInventory(item)] });
      }
      if (call.method === "PATCH" && call.path === PATHS.inventoryItem("d-1")) {
        return json(400, { error: { code: "invalid_request" } });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    const view = renderFleet(server.transport);
    await openEditor(user, "d-1");
    await user.clear(field("Seriennummer"));
    await user.type(field("Seriennummer"), "SN ungueltig");
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Die Anfrage wurde vom Server abgelehnt.");
    expect(field("Seriennummer").value).toBe("SN ungueltig");
    expect(within(rowOf("d-1")).getByText("SN-1")).toBeTruthy();
    view.unmount();

    const readOnly = createTransport((call) => {
      const other = otherLists(call);
      if (other !== null) {
        return other;
      }
      if (call.method === "GET" && call.path === PATHS.inventory) {
        return json(200, { items: [wireInventory(item)] });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });
    render(
      <AdminShell fetchImpl={shellFetch()} role="Operator">
        <FleetPage transport={readOnly.transport} />
      </AdminShell>,
    );
    await within(await screen.findByRole("region", { name: "Inventar" })).findByRole("cell", { name: "d-1" });
    expect(within(rowOf("d-1")).queryByRole("button", { name: "Bearbeiten" })).toBeNull();
    expect(screen.queryByLabelText("Seriennummer")).toBeNull();
    expect(readOnly.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  });
});
