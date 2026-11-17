import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { FleetTablet, FleetTaxi } from "./fleetApi";
import { CONFLICT_MESSAGE } from "./fleetApi";
import {
  type Call,
  createTransport,
  json,
  PATHS,
  renderFleet,
  tablet,
  taxi,
  wireTablet,
  wireTaxi,
} from "./fleetTestSupport";

afterEach(() => {
  cleanup();
});

const PAIR = PATHS.taxiTablets("t-1");

function read(call: Call, taxis: () => readonly FleetTaxi[], tablets: () => readonly FleetTablet[]): Response | null {
  if (call.method !== "GET") {
    return null;
  }
  if (call.path === PATHS.taxis) {
    return json(200, { items: taxis().map(wireTaxi) });
  }
  if (call.path === PATHS.tablets) {
    return json(200, { items: tablets().map(wireTablet) });
  }
  if (call.path === PATHS.groups || call.path === PATHS.inventory) {
    return json(200, { items: [] });
  }
  return null;
}

function cells(): string[] {
  const region = screen.getByRole("region", { name: "Taxis" });
  const row = within(region).getByRole("cell", { name: "t-1" }).closest("tr") as HTMLElement;
  return within(row).getAllByRole("cell").map((cell) => cell.textContent ?? "");
}

function pairRegion(): HTMLElement {
  return screen.getByRole("region", { name: "Tablet-Paar" });
}

function select(label: string): HTMLSelectElement {
  return within(pairRegion()).getByLabelText(label) as HTMLSelectElement;
}

function submit(): HTMLButtonElement {
  return within(pairRegion()).getByRole("button", { name: "Paar zuordnen" }) as HTMLButtonElement;
}

async function openEdit(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const region = screen.getByRole("region", { name: "Taxis" });
  const row = within(region).getByRole("cell", { name: "t-1" }).closest("tr") as HTMLElement;
  await user.click(within(row).getByRole("button", { name: "Bearbeiten" }));
  await screen.findByRole("region", { name: "Tablet-Paar" });
}

const TABLETS = [tablet({ id: "tab-a" }), tablet({ id: "tab-b" }), tablet({ id: "tab-c" })];

describe("CX-138 Tablet-Paar im Dashboard zuordnen", () => {
  it("speichert zwei unterschiedliche Tablets in genau einem Request ueber die Paarroute", async () => {
    const user = userEvent.setup();
    let current = taxi({ id: "t-1", revision: 2 });
    let release: () => void = () => undefined;
    const server = createTransport((call) => {
      const loaded = read(call, () => [current], () => TABLETS);
      if (loaded !== null) {
        return loaded;
      }
      if (call.method === "PUT" && call.path === PAIR) {
        return new Promise<Response>((resolve) => {
          release = () => {
            current = { ...current, tabletIds: ["tab-a", "tab-c"], revision: 3 };
            resolve(json(200, wireTaxi(current)));
          };
        });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);
    await screen.findByRole("cell", { name: "t-1" });
    await openEdit(user);
    await user.selectOptions(select("Tablet 1"), "tab-a");
    await user.selectOptions(select("Tablet 2"), "tab-c");
    await user.click(submit());
    // Mehrfaches Absenden waehrend der ausstehenden Antwort: kein weiterer Request.
    await user.click(submit());
    await user.click(submit());
    expect(server.count("PUT", PAIR)).toBe(1);
    // Vor dem Erfolg bleibt das bestaetigte Paar unveraendert.
    expect(cells().slice(3, 5)).not.toEqual(["tab-a", "tab-c"]);
    release();

    expect((await screen.findByRole("status")).textContent).toBe("Tablet-Paar gespeichert.");
    expect(server.count("PUT", PAIR)).toBe(1);
    expect(server.bodyOf("PUT", PAIR)).toEqual({ tablet_ids: ["tab-a", "tab-c"], revision: 2 });
    expect(cells().slice(3, 5)).toEqual(["tab-a", "tab-c"]);
    expect(server.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
  });

  it("verhindert unvollstaendige oder doppelte Paare und behaelt eine Auswahl, die die neue Liste nicht mehr enthaelt", async () => {
    const user = userEvent.setup();
    let tablets: FleetTablet[] = [...TABLETS];
    const server = createTransport((call) => {
      const loaded = read(call, () => [taxi({ id: "t-1", revision: 2 })], () => tablets);
      if (loaded !== null) {
        return loaded;
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);
    await screen.findByRole("cell", { name: "t-1" });
    await openEdit(user);

    await user.selectOptions(select("Tablet 1"), "tab-a");
    await user.click(submit());
    expect((await screen.findByRole("alert")).textContent).toBe("Bitte zwei verschiedene, verfügbare Tablets auswählen.");
    await user.selectOptions(select("Tablet 2"), "tab-a");
    await user.click(submit());
    expect(screen.getByRole("alert").textContent).toBe("Bitte zwei verschiedene, verfügbare Tablets auswählen.");
    expect(server.count("PUT", PAIR)).toBe(0);
    await user.selectOptions(select("Tablet 2"), "tab-b");

    // Die naechste gelieferte Liste enthaelt tab-a nicht mehr (andere Seite/neuer Stand).
    tablets = [tablet({ id: "tab-b" }), tablet({ id: "tab-d" })];
    const before = server.count("GET", PATHS.tablets);
    const region = screen.getByRole("region", { name: "Taxis" });
    await user.click(within(region).getAllByRole("button", { name: "Aktualisieren" })[0] as HTMLElement);
    await waitFor(() => expect(server.count("GET", PATHS.tablets)).toBeGreaterThan(before));
    await within(pairRegion()).findAllByRole("option", { name: "Tablet tab-d" });

    expect(select("Tablet 1").value).toBe("tab-a");
    expect(select("Tablet 2").value).toBe("tab-b");
    expect(server.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  });

  it("laesst bei Belegungskonflikt das bestaetigte Paar unveraendert, erhaelt den Entwurf und ordnet nicht automatisch neu zu", async () => {
    const user = userEvent.setup();
    const confirmed = taxi({ id: "t-1", revision: 5, tabletIds: ["tab-x", "tab-y"] });
    const server = createTransport((call) => {
      const loaded = read(call, () => [confirmed], () => TABLETS);
      if (loaded !== null) {
        return loaded;
      }
      if (call.method === "PUT" && call.path === PAIR) {
        return json(409, { error: { code: "tablet_assigned" } });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);
    await screen.findByRole("cell", { name: "t-1" });
    await openEdit(user);
    const loadsBefore = server.count("GET", PATHS.taxis);

    await user.selectOptions(select("Tablet 1"), "tab-a");
    await user.selectOptions(select("Tablet 2"), "tab-b");
    await user.click(submit());

    expect((await screen.findByRole("alert")).textContent).toBe(CONFLICT_MESSAGE);
    expect(cells().slice(3, 5)).toEqual(["tab-x", "tab-y"]);
    expect(select("Tablet 1").value).toBe("tab-a");
    expect(select("Tablet 2").value).toBe("tab-b");
    expect(server.count("PUT", PAIR)).toBe(1);
    // Kein automatisches Nachladen und keine automatische Neuzuordnung.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.count("GET", PATHS.taxis)).toBe(loadsBefore);
    expect(server.count("PUT", PAIR)).toBe(1);

    // Erst bewusstes erneutes Absenden nach Korrektur erzeugt einen weiteren Paarrequest.
    await user.selectOptions(select("Tablet 2"), "tab-c");
    await user.click(submit());
    await waitFor(() => expect(server.count("PUT", PAIR)).toBe(2));
    expect(server.bodyOf("PUT", PAIR)).toEqual({ tablet_ids: ["tab-a", "tab-c"], revision: 5 });
    expect(cells().slice(3, 5)).toEqual(["tab-x", "tab-y"]);
  });
});
