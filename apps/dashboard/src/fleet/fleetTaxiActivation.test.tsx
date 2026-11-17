import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
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
  taxi,
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

function openTaxi(id: string): void {
  const row = screen.getByText(id).closest("tr");
  expect(row).not.toBeNull();
  fireEvent.click(
    within(row as HTMLTableRowElement).getByRole("button", {
      name: "Bearbeiten",
    }),
  );
}

function rowText(id: string): string {
  const row = screen.getByText(id).closest("tr");
  expect(row).not.toBeNull();
  return (row as HTMLTableRowElement).textContent ?? "";
}

/**
 * CX-139 / R-104: Die Aktivierung ist ein eigener Schreibweg. Er sendet den
 * ausdruecklichen Zielzustand samt bestaetigter Revision, wartet auf die
 * Serverantwort und laesst Pause-, Tablet-Aktivierungs- und
 * Identitaetswiderrufsrouten unberuehrt.
 */
describe("CX-139 Taxi-Aktivzustand ändern", () => {
  function readOnlyServer(getTaxis: () => FleetTaxi[]) {
    return createTransport((call) => {
      if (call.method === "GET" && call.path === PATHS.taxis) {
        return json(200, { items: getTaxis().map(wireTaxi) });
      }
      if (call.method === "GET" && call.path === PATHS.groups) {
        return json(200, { items: [] });
      }
      if (call.method === "GET" && call.path === PATHS.tablets) {
        return json(200, { items: [] });
      }
      if (call.method === "GET" && call.path === PATHS.inventory) {
        return json(200, { items: [] });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });
  }

  it("sendet beim Aktivieren und Deaktivieren den expliziten Zielzustand mit der bestätigten Revision und übernimmt die Serverantwort", async () => {
    const user = userEvent.setup();
    const taxis: FleetTaxi[] = [
      taxi({
        id: "t-1",
        displayName: "Taxi Eins",
        active: false,
        revision: 3,
        tabletIds: ["a", "b"],
      }),
    ];
    const sent: Array<Record<string, unknown>> = [];

    const base = readOnlyServer(() => taxis);
    const server = createTransport((call) => {
      if (
        call.method === "POST" &&
        call.path === PATHS.taxiActivation("t-1")
      ) {
        const body = bodyOf(call);
        sent.push(body);
        const current = taxis[0];
        if (current === undefined) {
          throw new Error("Taxi fehlt");
        }
        // Die Anfrage muss die zuletzt bestaetigte Revision tragen.
        expect(body.revision).toBe(current.revision);
        expect(typeof body.active).toBe("boolean");
        const updated: FleetTaxi = {
          ...current,
          active: body.active === true,
          revision: current.revision + 1,
        };
        taxis[0] = updated;
        // Die bestehende Route bestaetigt nur Zustand und Revision.
        return json(200, {
          active: updated.active,
          revision: updated.revision,
        });
      }
      return base.transport({ path: call.path, method: call.method as "GET" });
    });

    renderFleet(server.transport);
    await screen.findByText("t-1");
    expect(rowText("t-1")).toContain("Inaktiv");

    openTaxi("t-1");
    await user.click(
      screen.getByRole("button", { name: "Taxi aktivieren" }),
    );
    await screen.findByText("Taxi aktiviert.");

    expect(sent).toEqual([{ active: true, revision: 3 }]);
    expect(rowText("t-1")).toContain("Aktiv");
    // Die uebrigen bestaetigten Felder bleiben unveraendert erhalten.
    expect(rowText("t-1")).toContain("Taxi Eins");

    // Die naechste Aenderung verwendet die vom Server bestaetigte Revision.
    await user.click(
      screen.getByRole("button", { name: "Taxi deaktivieren" }),
    );
    await screen.findByText("Taxi deaktiviert.");

    expect(sent).toEqual([
      { active: true, revision: 3 },
      { active: false, revision: 4 },
    ]);
    expect(rowText("t-1")).toContain("Inaktiv");
    expect(
      screen.getByRole("button", { name: "Taxi aktivieren" }),
    ).toBeTruthy();
    expect(server.count("POST", PATHS.taxiActivation("t-1"))).toBe(2);
  });

  it("erzeugt beim Doppelklick während des Requests genau einen Schreibrequest und schaltet den Zustand nicht lokal mehrfach um", async () => {
    const taxis: FleetTaxi[] = [
      taxi({
        id: "t-2",
        displayName: "Taxi Zwei",
        active: false,
        revision: 7,
        tabletIds: ["a", "b"],
      }),
    ];
    const sent: Array<Record<string, unknown>> = [];
    const gate = deferred<Response>();

    const base = readOnlyServer(() => taxis);
    const server = createTransport((call) => {
      if (
        call.method === "POST" &&
        call.path === PATHS.taxiActivation("t-2")
      ) {
        sent.push(bodyOf(call));
        return gate.promise;
      }
      return base.transport({ path: call.path, method: call.method as "GET" });
    });

    renderFleet(server.transport);
    await screen.findByText("t-2");
    openTaxi("t-2");

    const button = screen.getByRole("button", {
      name: "Taxi aktivieren",
    }) as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);

    expect(server.count("POST", PATHS.taxiActivation("t-2"))).toBe(1);
    expect(sent).toEqual([{ active: true, revision: 7 }]);
    // Keine optimistische Umschaltung: Beschriftung und Zeile bleiben beim
    // bestaetigten Zustand, waehrend die Antwort aussteht.
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Taxi aktivieren");
    expect(rowText("t-2")).toContain("Inaktiv");

    const current = taxis[0];
    if (current === undefined) {
      throw new Error("Taxi fehlt");
    }
    const updated: FleetTaxi = { ...current, active: true, revision: 8 };
    taxis[0] = updated;
    gate.resolve(
      json(200, { active: updated.active, revision: updated.revision }),
    );

    await screen.findByText("Taxi aktiviert.");
    expect(
      screen.getByRole("button", { name: "Taxi deaktivieren" }),
    ).toBeTruthy();
    expect(rowText("t-2")).toContain("Aktiv");
    expect(server.count("POST", PATHS.taxiActivation("t-2"))).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("behält bei 403 und Revisionskonflikt den bestätigten Zustand und ruft weder Pause- noch Tablet-Aktivierungsrouten auf", async () => {
    const user = userEvent.setup();
    const taxis: FleetTaxi[] = [
      taxi({
        id: "t-403",
        displayName: "Taxi Verboten",
        active: false,
        revision: 2,
        tabletIds: ["a", "b"],
      }),
      taxi({
        id: "t-409",
        displayName: "Taxi Konflikt",
        active: false,
        revision: 5,
        tabletIds: ["a", "b"],
      }),
    ];
    const sent: Array<Record<string, unknown>> = [];

    const base = readOnlyServer(() => taxis);
    const server = createTransport((call) => {
      if (
        call.method === "POST" &&
        call.path === PATHS.taxiActivation("t-403")
      ) {
        sent.push(bodyOf(call));
        return json(403, { error: "forbidden" });
      }
      if (
        call.method === "POST" &&
        call.path === PATHS.taxiActivation("t-409")
      ) {
        sent.push(bodyOf(call));
        return json(409, { error: { code: "revision_conflict" } });
      }
      return base.transport({ path: call.path, method: call.method as "GET" });
    });

    renderFleet(server.transport);
    await screen.findByText("t-403");

    openTaxi("t-403");
    await user.click(
      screen.getByRole("button", { name: "Taxi aktivieren" }),
    );
    const forbiddenAlert = await screen.findByRole("alert");
    expect(forbiddenAlert.textContent ?? "").toContain("nicht erlaubt");
    expect(rowText("t-403")).toContain("Inaktiv");
    expect(
      (
        screen.getByRole("button", {
          name: "Taxi aktivieren",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    openTaxi("t-409");
    await user.click(
      screen.getByRole("button", { name: "Taxi aktivieren" }),
    );
    const conflictAlert = await screen.findByRole("alert");
    expect(conflictAlert.textContent ?? "").toContain("inzwischen geändert");

    // Der Konflikt laedt nur die Anzeige neu; das Formular wird geschlossen
    // und nie automatisch mit einer frisch gelesenen Revision erneut gesendet.
    const taxiSection = within(
      screen.getByRole("region", { name: "Taxis" }),
    );
    await waitFor(() => {
      expect(
        (
          taxiSection.getByRole("button", {
            name: "Aktualisieren",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });
    expect(rowText("t-409")).toContain("Inaktiv");
    openTaxi("t-409");
    expect(
      screen.getByRole("button", { name: "Taxi aktivieren" }),
    ).toBeTruthy();

    expect(sent).toEqual([
      { active: true, revision: 2 },
      { active: true, revision: 5 },
    ]);
    expect(server.count("POST", PATHS.taxiActivation("t-403"))).toBe(1);
    expect(server.count("POST", PATHS.taxiActivation("t-409"))).toBe(1);
    expect(
      server.calls.some(
        (call) =>
          call.path.endsWith("/pause") ||
          call.path.endsWith("/resume") ||
          /\/tablets\/[^/]+\/activation$/.test(call.path),
      ),
    ).toBe(false);
  });
});
