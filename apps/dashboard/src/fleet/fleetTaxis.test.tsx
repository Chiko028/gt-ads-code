import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { createFleetClient } from "./fleetApi";
import type { FleetGroup, FleetTaxi } from "./fleetApi";
import {
  createTransport,
  group,
  json,
  PATHS,
  renderFleet,
  taxi,
  wireGroup,
  wireTaxi,
} from "./fleetTestSupport";

afterEach(() => {
  cleanup();
});

function bodyOf(call: { body: string | null }): Record<string, unknown> {
  return call.body === null
    ? {}
    : (JSON.parse(call.body) as Record<string, unknown>);
}

describe("CX-037 Taxi- und Gruppenseite", () => {
  it("lädt Taxis, legt Taxi und Gruppe an und ändert beides erst nach bestätigter Serverantwort", async () => {
    const user = userEvent.setup();

    const taxis: FleetTaxi[] = [];
    const groups: FleetGroup[] = [];

    const server = createTransport((call) => {
      if (call.method === "GET" && call.path === PATHS.taxis) {
        return json(200, { items: taxis.map(wireTaxi) });
      }
      if (call.method === "GET" && call.path === PATHS.groups) {
        return json(200, { items: groups.map(wireGroup) });
      }
      if (call.method === "GET" && call.path === PATHS.tablets) {
        return json(200, { items: [] });
      }
      if (call.method === "GET" && call.path === PATHS.inventory) {
        return json(200, { items: [] });
      }

      if (call.method === "POST" && call.path === PATHS.groups) {
        const body = bodyOf(call);
        const created = group({
          id: "g-1",
          name: String(body.name),
          revision: 1,
        });
        groups.push(created);
        return json(201, wireGroup(created));
      }
      if (call.method === "PATCH" && call.path === PATHS.group("g-1")) {
        const body = bodyOf(call);
        const current = groups[0];
        if (current === undefined) {
          throw new Error("Gruppe fehlt");
        }
        const saved: FleetGroup = {
          ...current,
          name: String(body.name),
          revision: current.revision + 1,
        };
        groups[0] = saved;
        return json(200, wireGroup(saved));
      }

      if (call.method === "POST" && call.path === PATHS.taxis) {
        const body = bodyOf(call);
        const created = taxi({
          id: String(body.id),
          displayName: String(body.display_name),
          groupIds: (body.group_ids as string[]) ?? [],
          revision: 1,
        });
        taxis.push(created);
        return json(201, wireTaxi(created));
      }
      if (call.method === "PATCH" && call.path === PATHS.taxi("t-1")) {
        const body = bodyOf(call);
        const current = taxis[0];
        if (current === undefined) {
          throw new Error("Taxi fehlt");
        }
        const saved: FleetTaxi = {
          ...current,
          displayName: String(body.display_name),
          groupIds: (body.group_ids as string[]) ?? [],
          revision: current.revision + 1,
        };
        taxis[0] = saved;
        return json(200, wireTaxi(saved));
      }

      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);

    await screen.findByText("Keine Taxis vorhanden.");

    // Gruppe zuerst anlegen, damit das Taxiformular sie anbieten kann.
    await user.type(screen.getByLabelText("Neue Gruppe"), "Nord");
    await user.click(screen.getByRole("button", { name: "Gruppe anlegen" }));
    await screen.findByText("Nord");
    expect(server.bodyOf("POST", PATHS.groups)).toEqual({ name: "Nord" });

    await user.click(screen.getByRole("button", { name: "Taxi anlegen" }));
    await user.type(screen.getByLabelText("Kennung"), "t-1");
    await user.type(screen.getByLabelText("Anzeigename"), "Erstes Taxi");
    await user.click(screen.getByLabelText("Nord"));
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    await screen.findByText("Taxi gespeichert.");
    const taxiRegion = screen.getByRole("region", { name: "Taxis" });
    const taxiTable = within(taxiRegion).getByRole("table");
    expect(within(taxiTable).getByText("t-1")).toBeTruthy();
    expect(within(taxiTable).getByText("Erstes Taxi")).toBeTruthy();
    expect(within(taxiTable).getByText("Inaktiv")).toBeTruthy();
    expect(within(taxiTable).getAllByText("Nicht belegt")).toHaveLength(2);
    expect(within(taxiTable).getByText("Nord")).toBeTruthy();

    expect(server.bodyOf("POST", PATHS.taxis)).toEqual({
      id: "t-1",
      display_name: "Erstes Taxi",
      group_ids: ["g-1"],
    });

    const taxiRow = within(taxiTable).getByText("t-1").closest("tr");
    expect(taxiRow).not.toBeNull();
    await user.click(
      within(taxiRow as HTMLTableRowElement).getByRole("button", {
        name: "Bearbeiten",
      }),
    );
    const nameInput = screen.getByLabelText("Anzeigename");
    await user.clear(nameInput);
    await user.type(nameInput, "Geändertes Taxi");
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    await screen.findByText("Geändertes Taxi");
    expect(server.bodyOf("PATCH", PATHS.taxi("t-1"))).toEqual({
      display_name: "Geändertes Taxi",
      group_ids: ["g-1"],
      revision: 1,
    });

    // Gruppe umbenennen; die Revision stammt aus der Serverantwort.
    const groupRegion = screen.getByRole("region", { name: "Gruppen" });
    await user.click(
      within(groupRegion).getByRole("button", { name: "Umbenennen" }),
    );
    const renameInput = within(groupRegion).getByLabelText(
      "Neuer Gruppenname",
    );
    await user.clear(renameInput);
    await user.type(renameInput, "Süd");
    await user.click(
      within(groupRegion).getByRole("button", { name: "Speichern" }),
    );

    await within(groupRegion).findByText("Süd");
    expect(server.bodyOf("PATCH", PATHS.group("g-1"))).toEqual({
      name: "Süd",
      revision: 1,
    });
  });

  it("nutzt ohne injizierten Transport den same-origin-fetch und genau die Verwaltungsroute", async () => {
    let calledUrl = "";
    let calledInit: RequestInit | undefined;
    const client = createFleetClient({
      fetchImpl: async (input, init) => {
        calledUrl = String(input);
        calledInit = init;
        return json(200, { items: [] });
      },
      getSessionGeneration: () => 0,
    });

    await client.listTaxis();

    expect(calledUrl).toBe("/v1/admin/taxis");
    expect(calledInit?.credentials).toBe("same-origin");
    expect(calledInit?.headers).toEqual({ Accept: "application/json" });
  });
});
