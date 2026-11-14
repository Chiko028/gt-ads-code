import {
  cleanup,
  fireEvent,
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

function bodyOf(call: { body: string | null }): Record<string, unknown> {
  return call.body === null
    ? {}
    : (JSON.parse(call.body) as Record<string, unknown>);
}

describe("CX-037 Inventar", () => {
  it("zeigt null als Nicht erfasst und speichert Seriennummer, Gerätetyp und Austauschvermerk ohne die Geräteidentität zu ändern", async () => {
    const user = userEvent.setup();

    const items: FleetInventoryItem[] = [
      inventoryItem({ deviceId: "d-1" }),
      inventoryItem({
        deviceId: "d-2",
        serialNumber: "SN-ALT",
        deviceType: "Altgerät",
        replacementNote: "Ersatzteil",
        adminActive: false,
        revision: 4,
      }),
    ];

    const server = createTransport((call) => {
      if (call.method === "GET" && call.path === PATHS.taxis) {
        return json(200, { items: [] });
      }
      if (call.method === "GET" && call.path === PATHS.groups) {
        return json(200, { items: [] });
      }
      if (call.method === "GET" && call.path === PATHS.tablets) {
        return json(200, { items: [] });
      }
      if (call.method === "GET" && call.path === PATHS.inventory) {
        return json(200, { items: items.map(wireInventory) });
      }
      if (call.method === "PATCH" && call.path === PATHS.inventoryItem("d-1")) {
        const body = bodyOf(call);
        const current = items[0];
        if (current === undefined) {
          throw new Error("Inventareintrag fehlt");
        }
        const saved: FleetInventoryItem = {
          ...current,
          serialNumber:
            body.serial_number === null
              ? null
              : String(body.serial_number),
          deviceType:
            body.device_type === null ? null : String(body.device_type),
          replacementNote:
            body.replacement_note === null
              ? null
              : String(body.replacement_note),
          revision: current.revision + 1,
        };
        items[0] = saved;
        return json(200, wireInventory(saved));
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);

    await screen.findByText("d-1");
    const firstRow = screen.getByText("d-1").closest("tr");
    expect(firstRow).not.toBeNull();
    expect(firstRow?.textContent ?? "").toContain("Nicht erfasst");
    const secondRow = screen.getByText("d-2").closest("tr");
    expect(secondRow?.textContent ?? "").toContain("SN-ALT");
    expect(secondRow?.textContent ?? "").toContain("Inaktiv");

    await user.click(
      within(firstRow as HTMLTableRowElement).getByRole("button", {
        name: "Bearbeiten",
      }),
    );

    const inventoryRegion = screen.getByRole("region", {
      name: "Inventar bearbeiten",
    });
    const serialInput = screen.getByLabelText("Seriennummer");
    await user.type(serialInput, "SN-123");
    await user.type(screen.getByLabelText("Gerätetyp"), "Pixel 8");
    await user.type(
      screen.getByLabelText("Austauschvermerk"),
      "Tausch A",
    );
    await user.click(
      within(inventoryRegion).getByRole("button", { name: "Speichern" }),
    );

    await screen.findByText("Inventardaten gespeichert.");
    expect(server.bodyOf("PATCH", PATHS.inventoryItem("d-1"))).toEqual({
      serial_number: "SN-123",
      device_type: "Pixel 8",
      replacement_note: "Tausch A",
      revision: 1,
    });
    const patchBody = server.bodyOf("PATCH", PATHS.inventoryItem("d-1"));
    expect(patchBody).not.toHaveProperty("id");
    expect(patchBody).not.toHaveProperty("device_id");
    expect(server.count("PATCH", PATHS.inventoryItem("d-1"))).toBe(1);

    // Laengenpruefung: kein zweiter Schreibrequest bei zu langer Eingabe.
    fireEvent.change(serialInput, {
      target: { value: "X".repeat(129) },
    });
    await user.click(
      within(inventoryRegion).getByRole("button", { name: "Speichern" }),
    );
    const lengthAlert = await screen.findByRole("alert");
    expect(lengthAlert.textContent ?? "").toContain("zu lang");
    expect(server.count("PATCH", PATHS.inventoryItem("d-1"))).toBe(1);

    // Leere Felder werden bewusst als null gesendet und wieder als
    // "Nicht erfasst" dargestellt.
    await user.clear(serialInput);
    await user.clear(screen.getByLabelText("Gerätetyp"));
    await user.clear(screen.getByLabelText("Austauschvermerk"));
    await user.click(
      within(inventoryRegion).getByRole("button", { name: "Speichern" }),
    );

    await screen.findAllByText("Nicht erfasst");
    expect(server.bodyOf("PATCH", PATHS.inventoryItem("d-1"))).toEqual({
      serial_number: null,
      device_type: null,
      replacement_note: null,
      revision: 2,
    });
    const inventoryTable = within(
      screen.getByRole("region", { name: "Inventar" }),
    ).getByRole("table");
    const updatedRow = within(inventoryTable).getByText("d-1").closest("tr");
    expect(updatedRow?.textContent ?? "").toContain("Nicht erfasst");
  });
});

