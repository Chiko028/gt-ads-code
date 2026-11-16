import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
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

/** Beantwortet die vier Ladepfade der Seite mit leeren Listen. */
function emptyRead(call: CallLike): Response | null {
  if (call.method !== "GET") {
    return null;
  }
  if (
    call.path === PATHS.taxis ||
    call.path === PATHS.groups ||
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

function nameInput(): HTMLInputElement {
  return screen.getByLabelText("Neue Gruppe") as HTMLInputElement;
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: "Gruppe anlegen",
  }) as HTMLButtonElement;
}

function formOf(input: HTMLInputElement): HTMLFormElement {
  const form = input.closest("form");
  if (form === null) {
    throw new Error("Gruppenformular fehlt");
  }
  return form;
}

describe("CX-135 Gruppenanlage im Dashboard", () => {
  it("sendet bei gueltiger Eingabe genau eine Anfrage und zeigt die serverbestaetigte Gruppe", async () => {
    const user = userEvent.setup();
    const groups: FleetGroup[] = [];

    const server = createTransport((call) => {
      const read = emptyRead(call);
      if (read !== null) {
        return read;
      }
      if (call.method === "POST" && call.path === PATHS.groups) {
        const body =
          call.body === null
            ? {}
            : (JSON.parse(call.body) as Record<string, unknown>);
        const created = group({
          id: "g-1",
          name: String(body.name),
          revision: 1,
        });
        groups.push(created);
        return json(201, wireGroup(created));
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);
    await screen.findByText("Keine Gruppen vorhanden.");

    await user.type(nameInput(), "Nord");
    await user.click(submitButton());

    await screen.findByText("Gruppe gespeichert.");
    const region = groupRegion();
    expect(within(region).getByText("Nord")).toBeTruthy();
    expect(within(region).queryByText("Keine Gruppen vorhanden.")).toBeNull();

    // Genau ein Schreibrequest ueber den vorhandenen authentifizierten Pfad.
    expect(server.count("POST", PATHS.groups)).toBe(1);
    expect(server.bodyOf("POST", PATHS.groups)).toEqual({ name: "Nord" });
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(groups).toHaveLength(1);
    expect(nameInput().value).toBe("");
  });

  it("erzeugt bei leerer Eingabe und erneutem Absenden waehrend einer Anfrage keinen weiteren Request", async () => {
    const user = userEvent.setup();
    let resolveCreate: (response: Response) => void = () => {
      throw new Error("Antwort nicht vorbereitet");
    };
    const pending = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });

    const server = createTransport((call) => {
      const read = emptyRead(call);
      if (read !== null) {
        return read;
      }
      if (call.method === "POST" && call.path === PATHS.groups) {
        return pending;
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(server.transport);
    await screen.findByText("Keine Gruppen vorhanden.");

    // Leere Eingabe wird lokal abgelehnt und erreicht den Transport nicht.
    await user.click(submitButton());
    expect(server.count("POST", PATHS.groups)).toBe(0);
    expect(screen.getByRole("alert").textContent).toContain(
      "Bitte einen Gruppennamen eingeben.",
    );

    await user.type(nameInput(), "Nord");
    const form = formOf(nameInput());

    // Zwei Absendungen im selben Tick: die synchrone Sperre laesst nur eine zu.
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(server.count("POST", PATHS.groups)).toBe(1);
    expect(submitButton().disabled).toBe(true);
    expect(nameInput().disabled).toBe(true);

    await act(async () => {
      resolveCreate(
        json(201, wireGroup(group({ id: "g-1", name: "Nord", revision: 1 }))),
      );
    });

    await screen.findByText("Gruppe gespeichert.");
    expect(within(groupRegion()).getByText("Nord")).toBeTruthy();
    expect(server.count("POST", PATHS.groups)).toBe(1);
  });

  it("behaelt die Eingabe bei 403 und Serverfehler und täuscht keine Gruppe vor", async () => {
    // 403: verstaendliche Meldung, Formularinhalt bleibt erhalten.
    const forbiddenUser = userEvent.setup();
    const forbiddenServer = createTransport((call) => {
      const read = emptyRead(call);
      if (read !== null) {
        return read;
      }
      if (call.method === "POST" && call.path === PATHS.groups) {
        return json(403, { error: "forbidden" });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(forbiddenServer.transport);
    await screen.findByText("Keine Gruppen vorhanden.");
    await forbiddenUser.type(nameInput(), "Nord");
    await forbiddenUser.click(submitButton());

    const forbiddenAlert = await screen.findByRole("alert");
    expect(forbiddenAlert.textContent).toContain("Die Aktion ist nicht erlaubt.");
    expect(nameInput().value).toBe("Nord");
    expect(within(groupRegion()).queryByRole("table")).toBeNull();
    expect(within(groupRegion()).getByText("Keine Gruppen vorhanden.")).toBeTruthy();
    expect(forbiddenServer.count("POST", PATHS.groups)).toBe(1);

    cleanup();

    // Serverfehler: unklarer Ausgang, keine erfundene Gruppe, Eingabe bleibt.
    const serverErrorUser = userEvent.setup();
    const serverErrorServer = createTransport((call) => {
      const read = emptyRead(call);
      if (read !== null) {
        return read;
      }
      if (call.method === "POST" && call.path === PATHS.groups) {
        return json(500, { error: "boom" });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.path);
    });

    renderFleet(serverErrorServer.transport);
    await screen.findByText("Keine Gruppen vorhanden.");
    await serverErrorUser.type(nameInput(), "Sued");
    await serverErrorUser.click(submitButton());

    const serverAlert = await screen.findByRole("alert");
    expect(serverAlert.textContent).toContain(
      "Der Ausgang der Änderung ist unklar.",
    );
    expect(nameInput().value).toBe("Sued");
    expect(within(groupRegion()).queryByRole("table")).toBeNull();
    expect(within(groupRegion()).getByText("Keine Gruppen vorhanden.")).toBeTruthy();
    expect(serverErrorServer.count("POST", PATHS.groups)).toBe(1);
  });
});
