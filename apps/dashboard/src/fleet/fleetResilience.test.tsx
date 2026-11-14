import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

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

describe("CX-037 Konflikt, unklarer Ausgang und Sitzungsablauf", () => {
  it("lädt bei 409 neu, wiederholt nicht automatisch, bietet bei unklarem Ausgang nur Nachladen an und verwirft verspätete Antworten nach 401", async () => {
    const user = userEvent.setup();

    const taxis: FleetTaxi[] = [
      taxi({ id: "t-1", displayName: "Alt", revision: 1 }),
    ];
    const groups: FleetGroup[] = [];

    let conflictOnce = false;
    let failNextWrite = false;
    let deferGets = false;
    let expireGroupCreate = false;
    const pendingGets: Array<{
      readonly path: string;
      readonly deferred: Deferred<Response>;
    }> = [];

    const server = createTransport((call) => {
      if (call.method === "GET") {
        if (deferGets) {
          const response = deferred<Response>();
          pendingGets.push({ path: call.path, deferred: response });
          return response.promise;
        }
        if (call.path === PATHS.taxis) {
          return json(200, { items: taxis.map(wireTaxi) });
        }
        if (call.path === PATHS.groups) {
          return json(200, { items: groups.map(wireGroup) });
        }
        if (call.path === PATHS.tablets) {
          return json(200, { items: [] });
        }
        if (call.path === PATHS.inventory) {
          return json(200, { items: [] });
        }
        throw new Error("Unerwarteter GET: " + call.path);
      }

      if (call.method === "PATCH" && call.path === PATHS.taxi("t-1")) {
        if (conflictOnce) {
          conflictOnce = false;
          return json(409, { error: { code: "revision_conflict" } });
        }
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("Netzwerk weg");
        }
        const body = call.body === null ? {} : JSON.parse(call.body);
        const current = taxis[0];
        if (current === undefined) {
          throw new Error("Taxi fehlt");
        }
        const saved: FleetTaxi = {
          ...current,
          displayName: String(body.display_name),
          revision: current.revision + 1,
        };
        taxis[0] = saved;
        return json(200, wireTaxi(saved));
      }

      if (call.method === "POST" && call.path === PATHS.groups) {
        if (expireGroupCreate) {
          return json(401, { error: { code: "unauthorized" } });
        }
        const body = call.body === null ? {} : JSON.parse(call.body);
        const created = group({
          id: "g-neu",
          name: String(body.name),
          revision: 1,
        });
        groups.push(created);
        return json(201, wireGroup(created));
      }

      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);
    await screen.findByText("t-1");

    // 1. Revisionskonflikt: 409 laedt die aktuellen Daten, ohne erneut zu
    // speichern und ohne einen lokalen Erfolg zu zeigen.
    conflictOnce = true;
    fireEvent.click(screen.getByRole("button", { name: "Bearbeiten" }));
    const nameInput = screen.getByLabelText("Anzeigename");
    await user.clear(nameInput);
    await user.type(nameInput, "Konfliktversuch");
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    const conflictAlert = await screen.findByRole("alert");
    expect(conflictAlert.textContent ?? "").toContain("inzwischen geändert");
    await waitFor(() => {
      expect(server.count("GET", PATHS.taxis)).toBe(2);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(server.count("PATCH", PATHS.taxi("t-1"))).toBe(1);
    expect(screen.queryByText("Taxi gespeichert.")).toBeNull();
    expect(screen.queryByLabelText("Anzeigename")).toBeNull();
    expect(screen.getByText("Alt")).toBeTruthy();

    // 2. Unklarer Transportausgang: kein automatischer Retry, nur Nachladen.
    fireEvent.click(screen.getByRole("button", { name: "Bearbeiten" }));
    const unclearName = screen.getByLabelText("Anzeigename");
    await user.clear(unclearName);
    await user.type(unclearName, "Unklarer Versuch");
    failNextWrite = true;
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    const unclearAlert = await screen.findByRole("alert");
    expect(unclearAlert.textContent ?? "").toContain("Ausgang der Änderung ist unklar");
    expect(
      screen.getByRole("button", { name: "Neu laden" }),
    ).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(server.count("PATCH", PATHS.taxi("t-1"))).toBe(2);
    expect(screen.queryByText("Taxi gespeichert.")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Neu laden" }));
    await waitFor(() => {
      expect(server.count("GET", PATHS.taxis)).toBe(3);
    });
    expect(server.count("PATCH", PATHS.taxi("t-1"))).toBe(2);
    expect(screen.queryByText("Taxi gespeichert.")).toBeNull();

    // 3. Sitzungsablauf: waehrend vier Listenabrufe haengen, liefert das
    // Anlegen einer Gruppe eine 401. Danach duerfen die verspaeteten
    // Antworten keine geschuetzten Inhalte wiederherstellen.
    deferGets = true;
    await user.click(
      within(screen.getByRole("region", { name: "Taxis" })).getByRole("button", {
        name: "Aktualisieren",
      }),
    );
    expect(pendingGets).toHaveLength(4);

    expireGroupCreate = true;
    await user.type(
      within(screen.getByRole("region", { name: "Gruppen" })).getByLabelText(
        "Neue Gruppe",
      ),
      "Auslauf",
    );
    await user.click(screen.getByRole("button", { name: "Gruppe anlegen" }));

    await screen.findByRole("heading", { name: "Anmeldung" });
    expect(screen.queryByRole("heading", { name: "Taxis" })).toBeNull();

    await act(async () => {
      for (const entry of pendingGets) {
        if (entry.path === PATHS.taxis) {
          entry.deferred.resolve(
            json(200, {
              items: [
                wireTaxi(
                  taxi({ id: "secret", displayName: "Geheime Daten" }),
                ),
              ],
            }),
          );
        } else if (entry.path === PATHS.groups) {
          entry.deferred.resolve(
            json(200, {
              items: [wireGroup(group({ id: "g-secret", name: "Geheim" }))],
            }),
          );
        } else {
          entry.deferred.resolve(json(200, { items: [] }));
        }
      }
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: "Anmeldung" })).toBeTruthy();
    expect(screen.queryByText("Geheime Daten")).toBeNull();
    expect(screen.queryByText("Geheim")).toBeNull();
    expect(server.count("PATCH", PATHS.taxi("t-1"))).toBe(2);
  });
});

