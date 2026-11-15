import {
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { FleetTaxi } from "./fleetApi";
import {
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

function bodyOf(call: { body: string | null }): Record<string, unknown> {
  return call.body === null
    ? {}
    : (JSON.parse(call.body) as Record<string, unknown>);
}

describe("CX-037 Tablet-Paar und Aktivierung", () => {
  it("verlangt zwei verschiedene verfügbare Tablets, erzeugt beim Doppelklick nur einen Request und aktiviert erst mit vollständigem Paar", async () => {
    const user = userEvent.setup();

    const taxis: FleetTaxi[] = [
      taxi({ id: "t-free", displayName: "Frei", tabletIds: [null, null] }),
      taxi({ id: "t-empty", displayName: "Ohne Paar", tabletIds: [null, null] }),
      taxi({
        id: "t-active",
        displayName: "Aktiv",
        active: true,
        tabletIds: ["a", "b"],
      }),
    ];
    const tablets = [
      tablet({ id: "a", label: "Tablet A" }),
      tablet({ id: "b", label: "Tablet B" }),
      tablet({ id: "c", label: "Tablet C" }),
    ];

    const pendingPairs: Array<Deferred<Response>> = [];
    let deferPair = false;

    const server = createTransport((call) => {
      if (call.method === "GET" && call.path === PATHS.taxis) {
        return json(200, { items: taxis.map(wireTaxi) });
      }
      if (call.method === "GET" && call.path === PATHS.groups) {
        return json(200, { items: [] });
      }
      if (call.method === "GET" && call.path === PATHS.tablets) {
        return json(200, { items: tablets.map(wireTablet) });
      }
      if (call.method === "GET" && call.path === PATHS.inventory) {
        return json(200, { items: [] });
      }

      if (call.method === "PUT" && call.path === PATHS.taxiTablets("t-free")) {
        const body = bodyOf(call);
        const current = taxis.find((item) => item.id === "t-free");
        if (current === undefined) {
          throw new Error("Taxi fehlt");
        }
        const updated: FleetTaxi = {
          ...current,
          tabletIds: body.tablet_ids as [string, string],
          revision: current.revision + 1,
        };
        taxis[0] = updated;
        const response = json(200, wireTaxi(updated));
        if (deferPair) {
          const gate = deferred<Response>();
          pendingPairs.push(gate);
          return gate.promise;
        }
        return response;
      }

      if (
        call.method === "POST" &&
        call.path === PATHS.taxiActivation("t-free")
      ) {
        const body = bodyOf(call);
        const current = taxis.find((item) => item.id === "t-free");
        if (current === undefined) {
          throw new Error("Taxi fehlt");
        }
        const updated: FleetTaxi = {
          ...current,
          active: body.active === true,
          revision: current.revision + 1,
        };
        taxis[0] = updated;
        return json(200, wireTaxi(updated));
      }

      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);

    await screen.findByText("t-free");

    function openTaxi(id: string): void {
      const row = screen.getByText(id).closest("tr");
      expect(row).not.toBeNull();
      fireEvent.click(
        within(row as HTMLTableRowElement).getByRole("button", {
          name: "Bearbeiten",
        }),
      );
    }

    openTaxi("t-free");

    await user.selectOptions(screen.getByLabelText("Tablet 1"), "a");
    await user.selectOptions(screen.getByLabelText("Tablet 2"), "a");
    await user.click(screen.getByRole("button", { name: "Paar zuordnen" }));

    const samePairAlert = await screen.findByRole("alert");
    expect(samePairAlert.textContent ?? "").toContain(
      "zwei verschiedene, verfügbare Tablets",
    );
    expect(server.count("PUT", PATHS.taxiTablets("t-free"))).toBe(0);

    await user.selectOptions(screen.getByLabelText("Tablet 2"), "b");

    deferPair = true;
    const pairButton = screen.getByRole("button", { name: "Paar zuordnen" });
    fireEvent.click(pairButton);
    fireEvent.click(pairButton);

    expect(server.count("PUT", PATHS.taxiTablets("t-free"))).toBe(1);
    expect(server.bodyOf("PUT", PATHS.taxiTablets("t-free"))).toEqual({
      tablet_ids: ["a", "b"],
      revision: 1,
    });

    const updatedTaxi = taxis[0];
    if (updatedTaxi === undefined) {
      throw new Error("Taxi fehlt");
    }
    pendingPairs[0]?.resolve(json(200, wireTaxi(updatedTaxi)));
    await screen.findByText("Tablet-Paar gespeichert.");

    await user.click(screen.getByRole("button", { name: "Taxi aktivieren" }));
    await screen.findByText("Taxi aktiviert.");

    expect(server.count("POST", PATHS.taxiActivation("t-free"))).toBe(1);
    expect(server.bodyOf("POST", PATHS.taxiActivation("t-free"))).toEqual({
      active: true,
      revision: 2,
    });

    const activeRow = screen.getByText("t-free").closest("tr");
    expect(activeRow?.textContent ?? "").toContain("Aktiv");

    // Nach der Bestaetigung ist das Taxi aktiv; ein Paarwechsel ist gesperrt.
    const firstSelect = screen.getByLabelText("Tablet 1") as HTMLSelectElement;
    const secondSelect = screen.getByLabelText("Tablet 2") as HTMLSelectElement;
    expect(firstSelect.disabled).toBe(true);
    expect(secondSelect.disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Paar zuordnen" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // Ohne vollstaendiges Paar ist die Aktivierung gesperrt.
    openTaxi("t-empty");
    const activateWithoutPair = screen.getByRole("button", {
      name: "Taxi aktivieren",
    }) as HTMLButtonElement;
    expect(activateWithoutPair.disabled).toBe(true);
    fireEvent.click(activateWithoutPair);
    expect(server.count("POST", PATHS.taxiActivation("t-empty"))).toBe(0);

    // Die bloße Auswahl zweier Tablets ersetzt keine bestätigte
    // Paarzuordnung und schaltet die Aktivierung nicht frei.
    await user.selectOptions(screen.getByLabelText("Tablet 1"), "a");
    await user.selectOptions(screen.getByLabelText("Tablet 2"), "b");
    const stillBlocked = screen.getByRole("button", {
      name: "Taxi aktivieren",
    }) as HTMLButtonElement;
    expect(stillBlocked.disabled).toBe(true);
    fireEvent.click(stillBlocked);
    expect(server.count("POST", PATHS.taxiActivation("t-empty"))).toBe(0);

    // Ein aktives Taxi bietet gar keine Paarzuordnung an.
    openTaxi("t-active");
    expect(screen.getByText(/Einem aktiven Taxi kann kein neues Tablet-Paar/)).toBeTruthy();
    expect(
      (screen.getByLabelText("Tablet 1") as HTMLSelectElement).disabled,
    ).toBe(true);
  });
});

