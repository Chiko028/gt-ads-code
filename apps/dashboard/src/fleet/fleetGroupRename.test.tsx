import {
  cleanup,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { FleetGroup } from "./fleetApi";
import {
  createTransport,
  group,
  json,
  PATHS,
  renderFleet,
  wireGroup,
} from "./fleetTestSupport";

afterEach(() => {
  cleanup();
});

interface CallLike {
  readonly path: string;
  readonly method: string;
  readonly body: string | null;
}

/** Beantwortet die vier Ladepfade; Gruppen kommen aus dem uebergebenen Stand. */
function readGroups(call: CallLike, groups: readonly FleetGroup[]): Response | null {
  if (call.method !== "GET") {
    return null;
  }
  if (call.path === PATHS.groups) {
    return json(200, { items: groups.map(wireGroup) });
  }
  if (
    call.path === PATHS.taxis ||
    call.path === PATHS.tablets ||
    call.path === PATHS.inventory
  ) {
    return json(200, { items: [] });
  }
  return null;
}

function groupRegion(): HTMLElement {
  return screen.getByRole("region", { name: "Gruppen" });
}

function renameButton(): HTMLButtonElement {
  return within(groupRegion()).getByRole("button", {
    name: "Umbenennen",
  }) as HTMLButtonElement;
}

function nameInput(): HTMLInputElement {
  return within(groupRegion()).getByLabelText(
    "Neuer Gruppenname",
  ) as HTMLInputElement;
}

function saveButton(): HTMLButtonElement {
  return within(groupRegion()).getByRole("button", {
    name: "Speichern",
  }) as HTMLButtonElement;
}

function cancelButton(): HTMLButtonElement {
  return within(groupRegion()).getByRole("button", {
    name: "Abbrechen",
  }) as HTMLButtonElement;
}

describe("CX-136 Gruppenname im Dashboard aendern", () => {
  it("sendet Kennung, neuen Namen und Revision und zeigt die Serverantwort", async () => {
    const user = userEvent.setup();
    const initial = group({ id: "g-1", name: "Alt", revision: 7 });
    const confirmed = group({ id: "g-1", name: "Neu", revision: 8 });

    const server = createTransport((call) => {
      const read = readGroups(call, [initial]);
      if (read !== null) {
        return read;
      }
      if (call.method === "PATCH" && call.path === PATHS.group("g-1")) {
        return json(200, wireGroup(confirmed));
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);
    await screen.findByText("Alt");

    await user.click(renameButton());
    const input = nameInput();
    expect(input.value).toBe("Alt");
    await user.clear(input);
    await user.type(input, "Neu");
    await user.click(saveButton());

    // Erst die bestaetigte Serverantwort ersetzt den sichtbaren Namen.
    await screen.findByText("Neu");
    expect(within(groupRegion()).getByText("Neu")).toBeTruthy();
    expect(within(groupRegion()).queryByLabelText("Neuer Gruppenname")).toBeNull();

    expect(server.count("PATCH", PATHS.group("g-1"))).toBe(1);
    expect(server.bodyOf("PATCH", PATHS.group("g-1"))).toEqual({
      name: "Neu",
      revision: 7,
    });
  });

  it("behaelt bei Revisionskonflikt die Eingabe und schreibt nicht erneut", async () => {
    const user = userEvent.setup();
    const initial = group({ id: "g-1", name: "Alt", revision: 7 });

    const server = createTransport((call) => {
      const read = readGroups(call, [initial]);
      if (read !== null) {
        return read;
      }
      if (call.method === "PATCH" && call.path === PATHS.group("g-1")) {
        return json(409, { error: "conflict" });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);
    await screen.findByText("Alt");

    await user.click(renameButton());
    const input = nameInput();
    await user.clear(input);
    await user.type(input, "Neu");
    await user.click(saveButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("inzwischen geändert");
    // Der eingegebene Name bleibt erhalten.
    expect(input.value).toBe("Neu");
    expect(within(groupRegion()).getByText("Alt")).toBeTruthy();

    // Genau ein Schreibrequest; kein automatisches Nachladen oder Ueberschreiben.
    expect(server.count("PATCH", PATHS.group("g-1"))).toBe(1);
    expect(server.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
    expect(server.count("GET", PATHS.groups)).toBe(1);

    // Erneutes Laden wird ausdruecklich angeboten, nicht automatisch ausgeloest.
    const reload = within(groupRegion()).getByRole("button", {
      name: "Neu laden",
    });
    expect(saveButton().disabled).toBe(true);

    await user.click(reload);
    await waitFor(() => {
      expect(server.count("GET", PATHS.groups)).toBe(2);
    });
    expect(input.value).toBe("Neu");
    expect(server.count("PATCH", PATHS.group("g-1"))).toBe(1);
  });

  it("sendet beim Abbrechen nichts und laesst bei 403 den bisherigen Namen unveraendert", async () => {
    const user = userEvent.setup();
    const initial = group({ id: "g-1", name: "Alt", revision: 3 });

    const server = createTransport((call) => {
      const read = readGroups(call, [initial]);
      if (read !== null) {
        return read;
      }
      if (call.method === "PATCH" && call.path === PATHS.group("g-1")) {
        return json(403, { error: "forbidden" });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);
    await screen.findByText("Alt");

    // Abbrechen hat keine Serverwirkung.
    await user.click(renameButton());
    const input = nameInput();
    await user.clear(input);
    await user.type(input, "Neu");
    await user.click(cancelButton());

    expect(server.count("PATCH", PATHS.group("g-1"))).toBe(0);
    expect(within(groupRegion()).getByText("Alt")).toBeTruthy();
    expect(within(groupRegion()).queryByLabelText("Neuer Gruppenname")).toBeNull();

    // 403: verstaendliche Meldung, bisheriger Name bleibt unveraendert.
    await user.click(renameButton());
    const secondInput = nameInput();
    await user.clear(secondInput);
    await user.type(secondInput, "Neu2");
    await user.click(saveButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Die Aktion ist nicht erlaubt.");
    expect(server.count("PATCH", PATHS.group("g-1"))).toBe(1);
    expect(secondInput.value).toBe("Neu2");
    expect(within(groupRegion()).getByText("Alt")).toBeTruthy();

    await user.click(cancelButton());
    expect(within(groupRegion()).getByText("Alt")).toBeTruthy();
    expect(server.count("PATCH", PATHS.group("g-1"))).toBe(1);
  });
});

