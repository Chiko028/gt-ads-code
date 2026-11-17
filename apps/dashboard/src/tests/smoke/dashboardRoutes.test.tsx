// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../../App";
import { AdminShell } from "../../admin/AdminShell";
import type { FetchLike } from "../../admin/adminApi";
import { NavigationFrame } from "../../navigation/NavigationFrame";
import { OperationsPage } from "../../operations/OperationsPage";

interface FetchCall {
  readonly method: string;
  readonly url: string;
}

const RENDER_ERROR_HEADING = "Seiteninhalt nicht verfügbar";

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const DEVICE_LIST = {
  server_time: "2026-11-17T01:00:00.000Z",
  online_threshold_s: 120,
  items: [
    {
      id: "dev-syn",
      label: "SYN-Tablet",
      manufacturer: "Acme",
      model: "X1",
      os_version: "14",
      sdk_int: 34,
      app_version: "1.2.3",
      app_flavor: "prod",
      state: "active",
      registered_at: "2026-11-01T09:00:00.000Z",
      last_seen_at: "2026-11-17T00:59:00.000Z",
      connectivity: "reachable",
    },
  ],
  truncated: false,
};

/**
 * Synthetischer, angemeldeter Server ohne Netzwerk: Sitzungspruefung,
 * Geraete und Benutzer liefern Testdaten, alle uebrigen Lesewege eine leere
 * Liste. Jeder schreibende Aufruf wird protokolliert und vom Test abgelehnt.
 */
function createServer(authenticated: boolean) {
  const calls: FetchCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const call: FetchCall = { method: init?.method ?? "GET", url: String(input) };
    calls.push(call);
    if (!authenticated) {
      return jsonResponse(401, { error: { code: "unauthorized" } });
    }
    if (call.method !== "GET") {
      return jsonResponse(405, { error: { code: "invalid_request" } });
    }
    if (call.url === "/v1/admin/devices") {
      return jsonResponse(200, DEVICE_LIST);
    }
    if (call.url === "/v1/admin/operators") {
      return jsonResponse(200, { items: [{ id: "op-syn", username: "syn-benutzer", role: "Admin", status: "active" }] });
    }
    return jsonResponse(200, { items: [] });
  };
  return {
    fetchImpl,
    calls,
    mutations: () => calls.filter((call) => call.method !== "GET"),
  };
}

const ROUTES: ReadonlyArray<{ readonly hash: string; readonly heading: string }> = [
  { hash: "#/geraete", heading: "Geräte" },
  { hash: "#/taxis", heading: "Taxis" },
  { hash: "#/medien", heading: "Medien" },
  { hash: "#/kampagnen", heading: "Kampagnen" },
  { hash: "#/ausspielung", heading: "Ausspielung" },
  { hash: "#/statistik", heading: "Statistik" },
  { hash: "#/status", heading: "Status" },
  { hash: "#/bedienung", heading: "Bedienung" },
  { hash: "#/benutzer", heading: "Benutzer" },
  { hash: "#/betrieb", heading: "Betrieb" },
];

describe("CX-144 Dashboard-Routen und R-802-Rauchtest", () => {
  it.each(ROUTES)("rendert $hash in der echten App-Komposition ohne Renderfehler", async ({ hash, heading }) => {
    window.history.replaceState(null, "", "/" + hash);
    const server = createServer(true);
    render(<App fetchImpl={server.fetchImpl} />);

    expect(await screen.findByRole("heading", { level: 2, name: heading })).toBeTruthy();
    const navigation = screen.getByRole("navigation", { name: "Hauptnavigation" });
    expect(within(navigation).getByRole("link", { name: heading }).getAttribute("aria-current")).toBe("page");
    // Kurz auf Ladeantworten warten, dann darf kein Renderfehlerschutz sichtbar sein.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("heading", { name: RENDER_ERROR_HEADING })).toBeNull();
    expect(server.mutations()).toEqual([]);
  });

  it.each([
    ...ROUTES.map((route) => ({ ...route, role: "ohne Sitzung" as const })),
    { hash: "#/betrieb", heading: "Betrieb", role: "Operator" as const },
  ])("zeigt $hash $role keinen geschuetzten Inhalt und sendet keine Mutation", async ({ hash, heading, role }) => {
    window.history.replaceState(null, "", "/" + hash);
    if (role === "ohne Sitzung") {
      const server = createServer(false);
      render(<App fetchImpl={server.fetchImpl} />);
      expect(await screen.findByRole("heading", { name: "Anmeldung" })).toBeTruthy();
      expect(screen.queryByRole("heading", { level: 2, name: heading })).toBeNull();
      expect(screen.queryByRole("navigation", { name: "Hauptnavigation" })).toBeNull();
      expect(screen.queryByText("SYN-Tablet")).toBeNull();
      expect(server.mutations()).toEqual([]);
      return;
    }
    const server = createServer(true);
    render(
      <AdminShell fetchImpl={server.fetchImpl} role="Operator">
        <NavigationFrame operationsPage={<OperationsPage fetchImpl={server.fetchImpl} />} />
      </AdminShell>,
    );
    const navigation = await screen.findByRole("navigation", { name: "Hauptnavigation" });
    expect(within(navigation).queryByRole("link", { name: "Betrieb" })).toBeNull();
    expect((await screen.findByRole("alert")).textContent).toContain("Kein Zugriff auf die Betriebsseite");
    expect(server.calls.some((call) => call.url.startsWith("/v1/admin/operations"))).toBe(false);
    expect(server.mutations()).toEqual([]);
  });

  it("zeigt fuer eine unbekannte Route einen neutralen Zustand mit Rueckweg zur Startseite", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/#/gibt-es-nicht");
    const server = createServer(true);
    render(<App fetchImpl={server.fetchImpl} />);

    expect(await screen.findByRole("heading", { name: "Seite nicht gefunden" })).toBeTruthy();
    const navigation = screen.getByRole("navigation", { name: "Hauptnavigation" });
    expect(within(navigation).queryByRole("link", { current: "page" })).toBeNull();

    await user.click(screen.getByRole("link", { name: "Zu den Geräten" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Geräte" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Seite nicht gefunden" })).toBeNull();
    expect(await screen.findByText("SYN-Tablet")).toBeTruthy();
  });

  it("haelt einen Seiten-Renderfehler im vorhandenen Fehlerschutz und rendert danach eine gueltige Route", async () => {
    const user = userEvent.setup();
    const originalError = console.error;
    console.error = () => undefined;
    try {
      function Broken(): never {
        throw new Error("SYN-Renderfehler CX-144");
      }
      window.history.replaceState(null, "", "/#/statistik");
      const server = createServer(true);
      render(
        <AdminShell fetchImpl={server.fetchImpl}>
          <NavigationFrame statisticPage={<Broken />} />
        </AdminShell>,
      );

      expect(await screen.findByRole("heading", { name: RENDER_ERROR_HEADING })).toBeTruthy();
      expect(document.body.innerHTML).not.toContain("SYN-Renderfehler CX-144");
      const navigation = screen.getByRole("navigation", { name: "Hauptnavigation" });

      await user.click(within(navigation).getByRole("link", { name: "Geräte" }));
      expect(await screen.findByRole("heading", { level: 2, name: "Geräte" })).toBeTruthy();
      await waitFor(() => expect(screen.queryByRole("heading", { name: RENDER_ERROR_HEADING })).toBeNull());
      expect(await screen.findByText("SYN-Tablet")).toBeTruthy();
      expect(server.mutations()).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });
});
