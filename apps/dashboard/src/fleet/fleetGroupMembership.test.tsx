import { cleanup, screen, within } from "@testing-library/react";
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

interface CallLike {
  readonly path: string;
  readonly method: string;
  readonly body: string | null;
}

/** CX-119-Format der vorhandenen Zuordnungsroute. */
function membershipPath(id: string): string {
  return "/v1/admin/taxis/" + id + "/groups";
}

function readAll(
  call: CallLike,
  taxis: readonly FleetTaxi[],
  groups: readonly FleetGroup[],
): Response | null {
  if (call.method !== "GET") {
    return null;
  }
  if (call.path === PATHS.taxis) {
    return json(200, { items: taxis.map(wireTaxi) });
  }
  if (call.path === PATHS.groups) {
    return json(200, { items: groups.map(wireGroup) });
  }
  if (call.path === PATHS.tablets || call.path === PATHS.inventory) {
    return json(200, { items: [] });
  }
  return null;
}

async function openMembership(
  user: ReturnType<typeof userEvent.setup>,
  groupName: string,
): Promise<HTMLElement> {
  const groupRegion = screen.getByRole("region", { name: "Gruppen" });
  const row = within(groupRegion).getByText(groupName).closest("tr");
  if (row === null) {
    throw new Error("Gruppenzeile fehlt");
  }
  await user.click(
    within(row).getByRole("button", { name: "Taxis zuordnen" }),
  );
  return screen.getByRole("region", { name: "Taxizugehörigkeit" });
}

function taxiTable(): HTMLElement {
  const region = screen.getByRole("region", { name: "Taxis" });
  return within(region).getByRole("table");
}

function checkboxIn(region: HTMLElement): HTMLInputElement {
  return within(region).getByRole("checkbox", {
    name: /Wagen Nord/,
  }) as HTMLInputElement;
}

function saveIn(region: HTMLElement): HTMLButtonElement {
  return within(region).getByRole("button", {
    name: "Zuordnung speichern",
  }) as HTMLButtonElement;
}

describe("CX-137 Gruppenzuordnung im Dashboard speichern", () => {
  it("speichert eine geänderte Auswahl genau einmal im CX-119-Format und zeigt das bestätigte Ergebnis", async () => {
    const user = userEvent.setup();
    const t1 = taxi({
      id: "t-1",
      displayName: "Wagen Nord",
      groupIds: [],
      revision: 4,
    });
    const g1 = group({ id: "g-1", name: "Nord", revision: 1 });

    const server = createTransport((call) => {
      const read = readAll(call, [t1], [g1]);
      if (read !== null) {
        return read;
      }
      if (call.method === "PUT" && call.path === membershipPath("t-1")) {
        return json(200, {
          taxi_id: "t-1",
          group_ids: ["g-1"],
          revision: 5,
        });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);
    await screen.findByText("Wagen Nord");
    expect(within(taxiTable()).getByText("Keine")).toBeTruthy();

    const membership = await openMembership(user, "Nord");
    const checkbox = checkboxIn(membership);
    expect(checkbox.checked).toBe(false);

    await user.click(checkbox);
    const save = saveIn(membership);
    expect(save.disabled).toBe(false);
    await user.click(save);

    await screen.findByText("Gruppenzuordnung gespeichert.");
    expect(server.count("PUT", membershipPath("t-1"))).toBe(1);
    expect(server.bodyOf("PUT", membershipPath("t-1"))).toEqual({
      group_ids: ["g-1"],
      revision: 4,
    });

    // Die sichtbare Zugehoerigkeit stammt aus der Serverbestaetigung.
    expect(within(taxiTable()).getByText("Nord")).toBeTruthy();
    expect(within(taxiTable()).queryByText("Keine")).toBeNull();
    expect(checkboxIn(membership).checked).toBe(true);
    expect(saveIn(membership).disabled).toBe(true);
  });

  it("erzeugt beim wiederholten Umschalten keine doppelten Kennungen und schreibt eine unveränderte Auswahl nicht", async () => {
    const user = userEvent.setup();
    const t1 = taxi({
      id: "t-1",
      displayName: "Wagen Nord",
      groupIds: [],
      revision: 2,
    });
    const g1 = group({ id: "g-1", name: "Nord", revision: 1 });

    const server = createTransport((call) => {
      const read = readAll(call, [t1], [g1]);
      if (read !== null) {
        return read;
      }
      if (call.method === "PUT" && call.path === membershipPath("t-1")) {
        return json(200, {
          taxi_id: "t-1",
          group_ids: ["g-1"],
          revision: 3,
        });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);
    await screen.findByText("Wagen Nord");

    const membership = await openMembership(user, "Nord");
    const checkbox = checkboxIn(membership);
    const save = saveIn(membership);

    // Drei Umschaltvorgaenge desselben Taxis: an, aus, wieder an.
    await user.click(checkbox);
    await user.click(checkbox);
    await user.click(checkbox);
    await user.click(save);

    await screen.findByText("Gruppenzuordnung gespeichert.");
    expect(server.count("PUT", membershipPath("t-1"))).toBe(1);
    const body = server.bodyOf("PUT", membershipPath("t-1")) as {
      group_ids: string[];
    };
    expect(body.group_ids).toEqual(["g-1"]);
    expect(new Set(body.group_ids).size).toBe(body.group_ids.length);

    // Auswahl entspricht jetzt dem bestaetigten Stand: kein weiterer Request.
    expect(saveIn(membership).disabled).toBe(true);
    await user.click(saveIn(membership));
    await user.click(checkboxIn(membership));
    await user.click(checkboxIn(membership));
    expect(saveIn(membership).disabled).toBe(true);
    await user.click(saveIn(membership));
    expect(server.count("PUT", membershipPath("t-1"))).toBe(1);
  });

  it("lässt bei einem Revisionskonflikt die bestätigte Zuordnung unverändert und behält den Entwurf", async () => {
    const user = userEvent.setup();
    const t1 = taxi({
      id: "t-1",
      displayName: "Wagen Nord",
      groupIds: ["g-1"],
      revision: 3,
    });
    const g1 = group({ id: "g-1", name: "Nord", revision: 1 });

    const server = createTransport((call) => {
      const read = readAll(call, [t1], [g1]);
      if (read !== null) {
        return read;
      }
      if (call.method === "PUT" && call.path === membershipPath("t-1")) {
        return json(409, { error: "conflict" });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);
    await screen.findByText("Wagen Nord");
    expect(within(taxiTable()).getByText("Nord")).toBeTruthy();

    const membership = await openMembership(user, "Nord");
    const checkbox = checkboxIn(membership);
    expect(checkbox.checked).toBe(true);

    await user.click(checkbox);
    expect(checkboxIn(membership).checked).toBe(false);
    await user.click(saveIn(membership));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("inzwischen geändert");

    // Bestaetigte Zugehoerigkeit bleibt sichtbar, der Entwurf bleibt bestehen.
    expect(within(taxiTable()).getByText("Nord")).toBeTruthy();
    expect(checkboxIn(membership).checked).toBe(false);
    expect(saveIn(membership).disabled).toBe(true);

    // Genau ein Versuch; kein automatisches Nachladen oder Wiederholen.
    expect(server.count("PUT", membershipPath("t-1"))).toBe(1);
    expect(server.count("GET", PATHS.taxis)).toBe(1);
    await user.click(saveIn(membership));
    expect(server.count("PUT", membershipPath("t-1"))).toBe(1);
  });
});
