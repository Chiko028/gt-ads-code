import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { FleetTablet } from "./fleetApi";
import {
  createTransport,
  json,
  PATHS,
  renderFleet,
  tablet,
  wireTablet,
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

function readOnlyServer(getTablets: () => FleetTablet[]) {
  return createTransport((call) => {
    if (call.method === "GET" && call.path === PATHS.taxis) {
      return json(200, { items: [] });
    }
    if (call.method === "GET" && call.path === PATHS.groups) {
      return json(200, { items: [] });
    }
    if (call.method === "GET" && call.path === PATHS.tablets) {
      return json(200, { items: getTablets().map(wireTablet) });
    }
    if (call.method === "GET" && call.path === PATHS.inventory) {
      return json(200, { items: [] });
    }
    throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
  });
}

function tabletRow(id: string): HTMLTableRowElement {
  const row = screen.getByText(id).closest("tr");
  expect(row).not.toBeNull();
  return row as HTMLTableRowElement;
}

function rowText(id: string): string {
  return tabletRow(id).textContent ?? "";
}

/**
 * CX-140 / R-104: Die Tablet-Aktivierung nutzt die bestehende CX-127-Route
 * ueber den vorhandenen authentifizierten Dashboard-Client. Der bestaetigte
 * Zustand wird erst nach der Serverantwort uebernommen; lesende Rollen sehen
 * keine Aenderungsaktion.
 */
describe("CX-140 Tablet-Aktivzustand ändern", () => {
  it("deaktiviert ein Tablet mit dessen ID und dem bestehenden API-Vertrag und übernimmt erst die bestätigte Antwort", async () => {
    const user = userEvent.setup();
    const tablets: FleetTablet[] = [
      tablet({ id: "tab-a", label: "Tablet A", active: true, revision: 3 }),
      tablet({ id: "tab-b", label: "Tablet B", active: true, revision: 4 }),
    ];
    const sent: Array<Record<string, unknown>> = [];

    const base = readOnlyServer(() => tablets);
    const server = createTransport((call) => {
      if (
        call.method === "PATCH" &&
        call.path === PATHS.tabletActivation("tab-a")
      ) {
        const body = bodyOf(call);
        sent.push(body);
        const current = tablets[0];
        if (current === undefined) {
          throw new Error("Tablet fehlt");
        }
        expect(body.expectedRevision).toBe(current.revision);
        expect(typeof body.active).toBe("boolean");
        const updated: FleetTablet = {
          ...current,
          active: body.active === true,
          revision: current.revision + 1,
        };
        tablets[0] = updated;
        return json(200, {
          active: updated.active,
          revision: updated.revision,
          taxi: null,
        });
      }
      return base.transport({
        path: call.path,
        method: call.method as "GET",
      });
    });

    renderFleet(server.transport);
    await screen.findByText("tab-a");
    expect(rowText("tab-a")).toContain("Aktiv");

    await user.click(
      within(tabletRow("tab-a")).getByRole("button", {
        name: "Tablet deaktivieren",
      }),
    );
    await screen.findByText("Tablet deaktiviert.");

    expect(sent).toEqual([{ active: false, expectedRevision: 3 }]);
    expect(rowText("tab-a")).toContain("Inaktiv");
    expect(rowText("tab-b")).toContain("Aktiv");
    expect(server.count("PATCH", PATHS.tabletActivation("tab-a"))).toBe(1);

    // Die Gegenrichtung verwendet die vom Server bestaetigte neue Revision.
    await user.click(
      within(tabletRow("tab-a")).getByRole("button", {
        name: "Tablet aktivieren",
      }),
    );
    await screen.findByText("Tablet aktiviert.");

    expect(sent).toEqual([
      { active: false, expectedRevision: 3 },
      { active: true, expectedRevision: 4 },
    ]);
    expect(rowText("tab-a")).toContain("Aktiv");
    expect(rowText("tab-b")).toContain("Aktiv");
    expect(server.count("PATCH", PATHS.tabletActivation("tab-a"))).toBe(2);
  });

  it("erzeugt während einer laufenden Änderung genau eine Anfrage und lässt das zweite Tablet unverändert", async () => {
    const tablets: FleetTablet[] = [
      tablet({ id: "tab-a", active: true, revision: 1 }),
      tablet({ id: "tab-b", active: false, revision: 2 }),
    ];
    const sent: Array<Record<string, unknown>> = [];
    const gate = deferred<Response>();

    const base = readOnlyServer(() => tablets);
    const server = createTransport((call) => {
      if (
        call.method === "PATCH" &&
        call.path === PATHS.tabletActivation("tab-a")
      ) {
        sent.push(bodyOf(call));
        return gate.promise;
      }
      return base.transport({
        path: call.path,
        method: call.method as "GET",
      });
    });

    renderFleet(server.transport);
    await screen.findByText("tab-a");

    const button = within(tabletRow("tab-a")).getByRole("button", {
      name: "Tablet deaktivieren",
    }) as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);

    expect(server.count("PATCH", PATHS.tabletActivation("tab-a"))).toBe(1);
    expect(sent).toEqual([{ active: false, expectedRevision: 1 }]);
    // Keine optimistische Umschaltung: Die Zeile bleibt beim bestaetigten
    // Zustand, solange die Antwort aussteht.
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Tablet deaktivieren");
    expect(rowText("tab-a")).toContain("Aktiv");
    expect(rowText("tab-b")).toContain("Inaktiv");

    gate.resolve(json(200, { active: false, revision: 2, taxi: null }));

    await screen.findByText("Tablet deaktiviert.");
    expect(rowText("tab-a")).toContain("Inaktiv");
    expect(rowText("tab-b")).toContain("Inaktiv");
    expect(server.count("PATCH", PATHS.tabletActivation("tab-a"))).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("behält bei Konflikt und Serverfehler den bestätigten Zustand und zeigt eine verständliche Meldung", async () => {
    const user = userEvent.setup();
    const tablets: FleetTablet[] = [
      tablet({
        id: "tab-conflict",
        label: "Konflikt",
        active: true,
        revision: 5,
      }),
      tablet({
        id: "tab-error",
        label: "Fehler",
        active: false,
        revision: 2,
      }),
    ];
    const sent: Array<{ path: string; body: Record<string, unknown> }> = [];

    const base = readOnlyServer(() => tablets);
    const server = createTransport((call) => {
      if (
        call.method === "PATCH" &&
        call.path === PATHS.tabletActivation("tab-conflict")
      ) {
        sent.push({ path: call.path, body: bodyOf(call) });
        return json(409, { error: { code: "revision_conflict" } });
      }
      if (
        call.method === "PATCH" &&
        call.path === PATHS.tabletActivation("tab-error")
      ) {
        sent.push({ path: call.path, body: bodyOf(call) });
        return json(500, { error: "server" });
      }
      return base.transport({
        path: call.path,
        method: call.method as "GET",
      });
    });

    renderFleet(server.transport);
    await screen.findByText("tab-conflict");

    await user.click(
      within(tabletRow("tab-conflict")).getByRole("button", {
        name: "Tablet deaktivieren",
      }),
    );
    await screen.findByText(/inzwischen geändert/);
    expect(rowText("tab-conflict")).toContain("Aktiv");

    // Der Konflikt laedt die bestaetigten Daten ueber den vorhandenen
    // Leseweg neu; es gibt keinen automatischen zweiten Schreibversuch.
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

    await user.click(
      within(tabletRow("tab-error")).getByRole("button", {
        name: "Tablet aktivieren",
      }),
    );
    await screen.findByText(/Ausgang der Änderung ist unklar/);
    expect(rowText("tab-error")).toContain("Inaktiv");
    expect(rowText("tab-conflict")).toContain("Aktiv");

    expect(sent).toEqual([
      {
        path: PATHS.tabletActivation("tab-conflict"),
        body: { active: false, expectedRevision: 5 },
      },
      {
        path: PATHS.tabletActivation("tab-error"),
        body: { active: true, expectedRevision: 2 },
      },
    ]);
    expect(server.count("PATCH", PATHS.tabletActivation("tab-conflict"))).toBe(
      1,
    );
    expect(server.count("PATCH", PATHS.tabletActivation("tab-error"))).toBe(1);
  });

  it("zeigt für eine lesende Operatorrolle keine Tablet-Änderungsaktion", async () => {
    const tablets: FleetTablet[] = [
      tablet({ id: "tab-read", active: true, revision: 1 }),
    ];
    const server = readOnlyServer(() => tablets);

    renderFleet(server.transport, "Operator");
    await screen.findByText("tab-read");

    const region = within(
      screen.getByRole("region", { name: "Tablets" }),
    );
    expect(
      region.queryByRole("button", { name: "Tablet deaktivieren" }),
    ).toBeNull();
    expect(
      region.queryByRole("button", { name: "Tablet aktivieren" }),
    ).toBeNull();
    expect(region.getByText("Keine Änderungsaktion verfügbar")).toBeTruthy();
    expect(server.count("PATCH", PATHS.tabletActivation("tab-read"))).toBe(0);
  });
});
