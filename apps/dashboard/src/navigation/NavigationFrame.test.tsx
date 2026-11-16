import { act } from "react";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { FetchLike } from "../admin/adminApi";
import { App } from "../App";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

interface FetchCall {
  url: string;
  method: string;
}

type DeviceHandler = () => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

function deviceListBody() {
  return {
    server_time: "2026-11-13T10:00:00.000Z",
    online_threshold_s: 120,
    items: [
      {
        id: "dev-1",
        label: "Werkstatt",
        manufacturer: "Acme",
        model: "X1",
        os_version: "14",
        sdk_int: 34,
        app_version: "1.2.3",
        app_flavor: "prod",
        state: "active",
        registered_at: "2026-11-01T09:00:00.000Z",
        last_seen_at: "2026-11-13T09:59:00.000Z",
        connectivity: "reachable",
      },
    ],
    truncated: false,
  };
}

/**
 * In-Memory-Server fuer den zentralen Admin-Client. Es gibt keine reale
 * Netzwerkverbindung; alle Antworten werden pro Pfad und Methode erzeugt.
 */
function createServer(options: { authenticated?: boolean } = {}) {
  let authenticated = options.authenticated ?? true;
  let deviceHandler: DeviceHandler | null = null;
  const calls: FetchCall[] = [];

  const fetchImpl: FetchLike = (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });

    if (method === "POST" && url.endsWith("/admin/login")) {
      authenticated = true;
      return Promise.resolve(emptyResponse());
    }
    if (method === "POST" && url.endsWith("/admin/logout")) {
      authenticated = false;
      return Promise.resolve(emptyResponse());
    }
    if (!authenticated) {
      return Promise.resolve(
        jsonResponse(401, { error: { code: "unauthorized" } }),
      );
    }
    if (
      method === "GET" &&
      url.endsWith("/admin/registration-codes")
    ) {
      return Promise.resolve(jsonResponse(200, { items: [] }));
    }
    if (method === "GET" && url.endsWith("/admin/devices")) {
      return deviceHandler === null
        ? Promise.resolve(jsonResponse(200, deviceListBody()))
        : deviceHandler();
    }
    return Promise.resolve(
      jsonResponse(404, { error: { code: "not_found" } }),
    );
  };

  return {
    fetchImpl,
    calls,
    setDeviceHandler(handler: DeviceHandler) {
      deviceHandler = handler;
    },
    loginCalls() {
      return calls.filter(
        (call) =>
          call.method === "POST" && call.url.endsWith("/admin/login"),
      ).length;
    },
    codesGets() {
      return calls.filter(
        (call) =>
          call.method === "GET" &&
          call.url.endsWith("/admin/registration-codes"),
      ).length;
    },
    devicesGets() {
      return calls.filter(
        (call) =>
          call.method === "GET" && call.url.endsWith("/admin/devices"),
      ).length;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

const NAV_LABELS = [
  "Geräte",
  "Taxis",
  "Medien",
  "Kampagnen",
  "Ausspielung",
  "Statistik",
  "Status",
  "Bedienung",
  "Benutzer",
  "Betrieb",
];

const PLACEHOLDER_LABELS = ["Status", "Bedienung", "Betrieb"];

describe("CX-034 Dashboard-Navigation", () => {
  it("bedient alle Navigationsziele, Direktaufruf per Hash, Zurück/Vorwärts und unbekannte Adressen", async () => {
    const net = createServer();
    const user = userEvent.setup();

    // Direktaufruf: die Anwendung startet auf dem per Hash gewaehlten Ziel.
    window.history.replaceState(null, "", "#/medien");
    render(<App fetchImpl={net.fetchImpl} />);
    await screen.findByRole("heading", { name: "Medien" });
    const mediaRegion = screen.getByRole("region", { name: "Medien" });
    expect(within(mediaRegion).getByLabelText("Datei")).toBeTruthy();
    expect(within(mediaRegion).getByRole("button", { name: "Hochladen" })).toBeTruthy();

    for (const label of NAV_LABELS) {
      await user.click(screen.getByRole("link", { name: label }));
      await screen.findByRole("heading", { name: label });
    }

    // Zurueck/Vorwaerts laufen ueber die native Browser-History.
    await user.click(screen.getByRole("link", { name: "Taxis" }));
    await screen.findByRole("heading", { name: "Taxis" });
    await user.click(screen.getByRole("link", { name: "Betrieb" }));
    await screen.findByRole("heading", { name: "Betrieb" });

    await act(async () => {
      window.history.back();
    });
    await screen.findByRole("heading", { name: "Taxis" });

    await act(async () => {
      window.history.forward();
    });
    await screen.findByRole("heading", { name: "Betrieb" });

    // Unbekannte Adresse zeigt eine sichtbare Nicht-gefunden-Seite.
    await act(async () => {
      window.location.hash = "#/unbekannt";
    });
    await screen.findByRole("heading", { name: "Seite nicht gefunden" });
    expect(
      screen.getByText("Die aufgerufene Adresse ist nicht bekannt."),
    ).toBeTruthy();

    // Von dort fuehrt ein nativer Link zurueck zu einem bekannten Ziel.
    await user.click(screen.getByRole("link", { name: "Zu den Geräten" }));
    await screen.findByRole("heading", { name: "Geräte" });
  });

  it("bindet Geräte- und Registrierungscodeverwaltung ein, ohne eine zweite Anmeldung oder Clientinstanz zu erzeugen", async () => {
    const net = createServer({ authenticated: false });
    const user = userEvent.setup();

    render(<App fetchImpl={net.fetchImpl} />);
    await screen.findByRole("heading", { name: "Anmeldung" });

    await user.type(screen.getByLabelText("Passwort"), "geheim");
    await user.click(screen.getByRole("button", { name: "Anmelden" }));

    await screen.findByRole("heading", { name: "Registrierungscodes" });
    await screen.findByRole("heading", { name: "Geräte" });
    expect(screen.getByText("Werkstatt")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Code erzeugen" })).toBeTruthy();
    expect(
      screen.getByText("Keine Registrierungscodes vorhanden."),
    ).toBeTruthy();
    expect(net.loginCalls()).toBe(1);

    const callsBeforeSwitch = net.calls.length;
    const codesBeforeSwitch = net.codesGets();

    await user.click(screen.getByRole("link", { name: "Taxis" }));
    await screen.findByRole("heading", { name: "Taxis" });
    await user.click(screen.getByRole("link", { name: "Geräte" }));
    await screen.findByRole("heading", { name: "Geräte" });
    await screen.findByText("Werkstatt");

    // Der Seitenwechsel nutzt dieselbe Sitzung und denselben Client: keine
    // erneute Anmeldung, keine erneute Sitzungspruefung, nur frische Daten.
    expect(net.loginCalls()).toBe(1);
    expect(net.codesGets()).toBe(codesBeforeSwitch);
    expect(net.calls.length).toBeGreaterThan(callsBeforeSwitch);
    const callsAfterSwitch = net.calls.slice(callsBeforeSwitch);
    expect(callsAfterSwitch.length).toBeGreaterThan(0);
    expect(
      callsAfterSwitch.every(
        (call) =>
          call.method === "GET" && call.url.includes("/admin/"),
      ),
    ).toBe(true);
    expect(
      callsAfterSwitch.every(
        (call) =>
          !call.url.includes("/admin/login") &&
          !call.url.includes("/admin/registration-codes"),
      ),
    ).toBe(true);
    expect(
      callsAfterSwitch.some((call) => call.url.endsWith("/admin/devices")),
    ).toBe(true);
    expect(screen.queryByRole("heading", { name: "Anmeldung" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Registrierungscodes" })).toBeTruthy();
  });

  it("blendet bei Abmeldung auf einer Unterseite geschützte Inhalte aus und ignoriert verspätete Ladeantworten", async () => {
    const net = createServer();
    const gate = deferred<Response>();
    net.setDeviceHandler(() => gate.promise);

    window.history.replaceState(null, "", "#/taxis");
    render(<App fetchImpl={net.fetchImpl} />);
    await screen.findByRole("heading", { name: "Taxis" });

    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "Geräte" }));
    await screen.findByRole("heading", { name: "Geräte" });
    await waitFor(() => expect(net.devicesGets()).toBe(1));
    expect(screen.getByText("Geräteliste wird geladen …")).toBeTruthy();

    // Abmeldung, waehrend die Geraeteantwort noch aussteht.
    await user.click(screen.getByRole("button", { name: "Abmelden" }));
    await screen.findByRole("heading", { name: "Anmeldung" });

    // Die verspaetete Antwort darf die geschuetzten Inhalte nicht oeffnen.
    await act(async () => {
      gate.resolve(jsonResponse(200, deviceListBody()));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Geräte" })).toBeNull();
    });

    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Registrierungscodes" })).toBeNull();
    expect(screen.queryByText("Werkstatt")).toBeNull();
    expect(screen.queryByText("Noch nicht verfügbar")).toBeNull();
    expect(screen.getByRole("heading", { name: "Anmeldung" })).toBeTruthy();
  });

  it("unterstützt Tastaturbedienung, markiert das aktive Ziel und kennzeichnet Platzhalter ohne Aktionen", async () => {
    const net = createServer();
    const user = userEvent.setup();

    render(<App fetchImpl={net.fetchImpl} />);
    await screen.findByRole("heading", { name: "Geräte" });

    const nav = screen.getByRole("navigation", { name: "Hauptnavigation" });
    expect(nav.tagName).toBe("NAV");
    expect(within(nav).getAllByRole("link")).toHaveLength(10);

    const devicesLink = within(nav).getByRole("link", { name: "Geräte" });
    expect(devicesLink.getAttribute("aria-current")).toBe("page");

    // Tastatur: Tab zum naechsten Ziel, Enter aktiviert den nativen Hashlink.
    devicesLink.focus();
    await user.tab();
    const taxisLink = within(nav).getByRole("link", { name: "Taxis" });
    expect(document.activeElement).toBe(taxisLink);
    await user.keyboard("{Enter}");
    await screen.findByRole("heading", { name: "Taxis" });

    expect(taxisLink.getAttribute("aria-current")).toBe("page");
    expect(devicesLink.getAttribute("aria-current")).toBeNull();

    for (const label of PLACEHOLDER_LABELS) {
      await user.click(within(nav).getByRole("link", { name: label }));
      await screen.findByRole("heading", { name: label });

      const region = screen.getByRole("region", { name: label });
      expect(within(region).getByText("Noch nicht verfügbar")).toBeTruthy();
      expect(within(region).queryByRole("table")).toBeNull();
      expect(within(region).queryByRole("button")).toBeNull();
      expect(within(region).queryByRole("form")).toBeNull();
      expect(within(region).queryByRole("textbox")).toBeNull();
      expect(within(region).queryByRole("link")).toBeNull();
      expect(within(region).queryByRole("list")).toBeNull();
    }

    // Benutzer ist kein Platzhalter mehr, sondern eine echte lesende Seite.
    await user.click(within(nav).getByRole("link", { name: "Benutzer" }));
    await screen.findByRole("heading", { name: "Benutzer" });
    const usersRegion = screen.getByRole("region", { name: "Benutzer" });
    expect(
      within(usersRegion).getByRole("button", { name: "Aktualisieren" }),
    ).toBeTruthy();
    expect(within(usersRegion).queryByText("Noch nicht verfügbar")).toBeNull();
  });
});
