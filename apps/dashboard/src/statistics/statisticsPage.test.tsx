/**
 * CX-050 / R-405: echte Vitest-React-Tests mit vorhandener Testing Library
 * und injiziertem Statistikclient. Keine Netzverbindung.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { AdminApiError } from "../admin/adminApi";
import type { FetchLike } from "../admin/adminApi";
import { AdminShell } from "../admin/AdminShell";
import { App } from "../App";
import type {
  DeviceQualityRow,
  PlayRow,
  StatisticsClient,
  StatisticsRequest,
  StatisticsResponse,
} from "./statisticsApi";
import { StatisticsPage } from "./StatisticsPage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

const NOW = new Date("2026-11-15T02:12:00.000Z");

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Sessionstub fuer AdminShell; die Statistikseite laedt nicht von selbst. */
const sessionFetch: FetchLike = (input, init) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (method === "GET" && url.endsWith("/admin/registration-codes")) {
    return Promise.resolve(jsonResponse(200, { items: [] }));
  }
  if (method === "GET" && url.endsWith("/admin/devices")) {
    return Promise.resolve(
      jsonResponse(200, {
        server_time: "2026-11-15T00:00:00.000Z",
        online_threshold_s: 120,
        items: [],
        truncated: false,
      }),
    );
  }
  return Promise.resolve(
    jsonResponse(404, { error: { code: "not_found" } }),
  );
};

function qualityRow(
  overrides: Partial<DeviceQualityRow> = {},
): DeviceQualityRow {
  return {
    deviceId: "geraet-1",
    taxiId: "taxi-1",
    availabilityRatio: 0.5,
    availabilityReason: null,
    observedMs: 3600000,
    technicalFaultMs: 0,
    syncErrors: 0,
    syncErrorScope: "device_or_taxi_time",
    ...overrides,
  };
}

function playRow(overrides: Partial<PlayRow> = {}): PlayRow {
  return {
    campaignId: "kampagne-1",
    deviceId: "geraet-1",
    taxiId: "taxi-1",
    playCount: 3,
    firstPlayedAt: "2026-11-10T08:00:00.000Z",
    lastPlayedAt: "2026-11-10T09:00:00.000Z",
    ...overrides,
  };
}

function statisticsResponse(
  overrides: Partial<StatisticsResponse> = {},
): StatisticsResponse {
  return {
    from: "2026-11-08T00:00:00.000Z",
    to: "2026-11-15T00:00:00.000Z",
    generatedAt: "2026-11-15T02:12:00.000Z",
    filters: { campaignId: null, deviceId: null, taxiId: null },
    definition: {
      interval: "[from,to)",
      playCount:
        "Summe gemeldeter Wiedergabeabschnitte; keine Sichtkontakte.",
      campaignAttribution: "Kampagne zur Wiedergabezeit.",
      taxiAttribution: "Historische Taxizuordnung zur Wiedergabezeit.",
      availability: "Anteil beobachteter Betriebszeit, sonst unbekannt.",
      syncErrors: "Deduplizierte Sync-Fehler im Geräte-/Zeitraum.",
      excludes: ["Sichtkontakte", "geschätzte Werte"],
    },
    completeness: {
      status: "complete",
      reasons: [],
      dataAsOf: "2026-11-14T23:00:00.000Z",
      missingDays: [],
    },
    rowLimit: 10000,
    rowCount: 0,
    qualityScope: "device_taxi_time",
    plays: [],
    deviceQuality: [],
    ...overrides,
  };
}

interface CapturedClient {
  readonly client: StatisticsClient;
  readonly requests: StatisticsRequest[];
}

function captureClient(
  handler: (
    request: StatisticsRequest,
    index: number,
  ) => Promise<StatisticsResponse>,
): CapturedClient {
  const requests: StatisticsRequest[] = [];
  const client: StatisticsClient = {
    getStatistics(request) {
      requests.push(request);
      return handler(request, requests.length - 1);
    },
  };
  return { client, requests };
}

async function renderPage(client: StatisticsClient): Promise<void> {
  render(
    <AdminShell fetchImpl={sessionFetch}>
      <StatisticsPage client={client} now={NOW} />
    </AdminShell>,
  );
  await screen.findByRole("heading", { name: "Statistik" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, resolve, reject };
}

describe("CX-050 Statistikseite", () => {
  it("setzt alle vier Filter und sendet die exakte Anfrage mit UTC-normalisierten Zeitgrenzen", async () => {
    const { client, requests } = captureClient(async () =>
      statisticsResponse(),
    );
    await renderPage(client);

    const from = screen.getByLabelText("Von (UTC)") as HTMLInputElement;
    const to = screen.getByLabelText("Bis (UTC)") as HTMLInputElement;

    // Initial: letzte sieben abgeschlossene UTC-Tage.
    expect(from.value).toBe("2026-11-08T00:00");
    expect(to.value).toBe("2026-11-15T00:00");

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("Kampagnen-ID (optional)"),
      "11111111-1111-4111-8111-111111111111",
    );
    await user.type(
      screen.getByLabelText("Geräte-ID (optional)"),
      "22222222-2222-4222-8222-222222222222",
    );
    await user.type(screen.getByLabelText("Taxi-ID (optional)"), "taxi-7");

    fireEvent.change(from, { target: { value: "2026-11-01T10:00" } });
    fireEvent.change(to, { target: { value: "2026-11-10T09:30" } });

    await user.click(screen.getByRole("button", { name: "Anwenden" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual({
      from: "2026-11-01T10:00:00.000Z",
      to: "2026-11-10T09:30:00.000Z",
      campaignId: "11111111-1111-4111-8111-111111111111",
      deviceId: "22222222-2222-4222-8222-222222222222",
      taxiId: "taxi-7",
    });
  });

  it("zeigt Wiedergaben und Gerätequalität getrennt, null als unbekannt und bestätigte Null als 0", async () => {
    const { client } = captureClient(async () =>
      statisticsResponse({
        rowCount: 3,
        plays: [playRow({ deviceId: "Wiedergabe-Geraet", playCount: 3 })],
        deviceQuality: [
          qualityRow({
            deviceId: "Qualitaet-ohne-Nenner",
            availabilityRatio: null,
            availabilityReason: "kein belastbarer Nenner",
            observedMs: null,
            technicalFaultMs: null,
            syncErrors: 2,
          }),
          qualityRow({
            deviceId: "Qualitaet-Null",
            availabilityRatio: 0,
            observedMs: 1000,
            technicalFaultMs: 1000,
            syncErrors: 0,
          }),
        ],
      }),
    );
    await renderPage(client);

    await userEvent.setup().click(
      screen.getByRole("button", { name: "Anwenden" }),
    );

    const playsRegion = await screen.findByRole("region", {
      name: "Gemeldete Wiedergaben",
    });
    const qualityRegion = await screen.findByRole("region", {
      name: "Gerätequalität und Sync-Fehler",
    });

    expect(screen.getAllByRole("table")).toHaveLength(2);

    const playLine = within(playsRegion).getByRole("row", {
      name: /Wiedergabe-Geraet/,
    });
    expect(within(playLine).getByText("3")).toBeTruthy();
    expect(
      within(playsRegion).getByText(
        "Gemeldete Wiedergaben – keine Sichtkontakte",
      ),
    ).toBeTruthy();
    expect(within(playsRegion).queryByText(/Sichtkontakte 3/)).toBeNull();

    const unknownRow = within(qualityRegion).getByRole("row", {
      name: /Qualitaet-ohne-Nenner/,
    });
    const availabilityCell = within(unknownRow).getAllByRole("cell")[2]!;
    expect(availabilityCell.textContent).toContain("unbekannt");
    expect(availabilityCell.textContent).not.toContain("0 %");
    expect(
      within(unknownRow).getByText(/kein belastbarer Nenner/),
    ).toBeTruthy();

    const zeroRow = within(qualityRegion).getByRole("row", {
      name: /Qualitaet-Null/,
    });
    expect(within(zeroRow).getByText("0 %")).toBeTruthy();

    // Messdefinition, Datenstand, Vollstaendigkeit und Geltungsbereich sind
    // sichtbar; die Geraetewerte haengen nicht an den Wiedergabezeilen.
    expect(screen.getByText("Messdefinition")).toBeTruthy();
    expect(screen.getByText("Datenstand (UTC): 2026-11-14T23:00:00.000Z")).toBeTruthy();
    expect(screen.getByText("Status: Vollständig")).toBeTruthy();
    expect(
      screen.getByText(
        "Geltungsbereich der Qualitätswerte: Gerät und Taxi im gewählten Zeitraum (device_taxi_time)",
      ),
    ).toBeTruthy();
  });

  it("zeigt den abweichenden Geltungsbereich der Sync-Fehler neben der Verfügbarkeit", async () => {
    const { client } = captureClient(async () =>
      statisticsResponse({
        // Verfuegbarkeit gilt fuer Gerät und Taxi, die Sync-Fehler dagegen
        // fuer Gerät oder Taxi: beide Geltungsbereiche muessen sichtbar sein.
        qualityScope: "device_taxi_time",
        deviceQuality: [
          qualityRow({
            deviceId: "Geltungsbereich-Geraet",
            syncErrors: 4,
            syncErrorScope: "device_or_taxi_time",
          }),
        ],
      }),
    );
    await renderPage(client);

    await userEvent.setup().click(
      screen.getByRole("button", { name: "Anwenden" }),
    );

    const qualityRegion = await screen.findByRole("region", {
      name: "Gerätequalität und Sync-Fehler",
    });
    expect(
      within(qualityRegion).getByText(
        /Geltungsbereich der Verfügbarkeit: Gerät und Taxi im gewählten Zeitraum \(device_taxi_time\)/,
      ),
    ).toBeTruthy();

    const row = within(qualityRegion).getByRole("row", {
      name: /Geltungsbereich-Geraet/,
    });
    const cells = within(row).getAllByRole("cell");
    expect(cells[5]!.textContent).toContain("4");
    expect(cells[5]!.textContent).toMatch(
      /Geltungsbereich: Gerät oder Taxi im gewählten Zeitraum \(device_or_taxi_time\)/,
    );
    expect(cells[2]!.textContent).not.toContain("device_or_taxi_time");
  });

  it("ignoriert eine ältere Antwort nach zwei schnellen Anfragen und zeigt bei Fehlern keine alten Zahlen", async () => {
    const gate1 = deferred<StatisticsResponse>();
    const gate2 = deferred<StatisticsResponse>();
    const gate3 = deferred<StatisticsResponse>();
    const gates = [gate1, gate2, gate3];
    const { client, requests } = captureClient(
      (_request, index) => gates[index]!.promise,
    );
    await renderPage(client);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Anwenden" }));
    await waitFor(() => expect(requests).toHaveLength(1));

    // Zweite Anfrage in schneller Folge, waehrend die erste noch offen ist.
    const from = screen.getByLabelText("Von (UTC)") as HTMLInputElement;
    fireEvent.change(from, { target: { value: "2026-11-02T00:00" } });
    await user.click(screen.getByRole("button", { name: "Anwenden" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]!.from).toBe("2026-11-02T00:00:00.000Z");

    await act(async () => {
      gate2.resolve(
        statisticsResponse({
          plays: [playRow({ deviceId: "Antwort-neu" })],
        }),
      );
      await Promise.resolve();
    });
    await screen.findByText("Antwort-neu");

    // Die verspaetete aeltere Antwort darf das neuere Ergebnis nicht ersetzen.
    await act(async () => {
      gate1.resolve(
        statisticsResponse({
          plays: [playRow({ deviceId: "Antwort-alt" })],
        }),
      );
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByText("Antwort-alt")).toBeNull();
    });
    expect(screen.getByText("Antwort-neu")).toBeTruthy();

    // Ein Fehler ersetzt das Ergebnis und laesst keine alten Zahlen stehen.
    await user.click(screen.getByRole("button", { name: "Anwenden" }));
    await waitFor(() => expect(requests).toHaveLength(3));
    await act(async () => {
      gate3.reject(new AdminApiError("network", "Der Server ist nicht erreichbar."));
      await Promise.resolve();
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Der Server ist nicht erreichbar.");
    expect(screen.queryByText("Antwort-neu")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("öffnet die Statistikseite aus der Navigation und unterscheidet leere, unvollständige sowie ungültige Zeiträume", async () => {
    // Navigation: der vorhandene Hash-Link oeffnet die eingebundene Seite.
    window.history.replaceState(null, "", "#/geraete");
    const navClient = captureClient(async () => statisticsResponse()).client;
    render(
      <App fetchImpl={sessionFetch} statisticsClient={navClient} />,
    );
    await screen.findByRole("heading", { name: "Geräte" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "Statistik" }));
    await screen.findByRole("heading", { name: "Statistik" });
    expect(
      screen.getByRole("link", { name: "Statistik" }).getAttribute(
        "aria-current",
      ),
    ).toBe("page");
    cleanup();

    const responses = [
      statisticsResponse(),
      statisticsResponse({
        completeness: {
          status: "incomplete",
          reasons: ["Rollup für einen Tag fehlt."],
          dataAsOf: "2026-11-14T23:00:00.000Z",
          missingDays: [
            { day: "2026-11-10", reason: "no_raw_evidence" },
          ],
        },
        plays: [playRow({ deviceId: "Teil-Geraet" })],
        rowCount: 1,
      }),
    ];
    let next = 0;
    const { client, requests } = captureClient(async () => {
      const response = responses[next];
      next += 1;
      if (response === undefined) {
        throw new Error("keine Antwort vorbereitet");
      }
      return response;
    });

    await renderPage(client);
    const from = screen.getByLabelText("Von (UTC)") as HTMLInputElement;
    const to = screen.getByLabelText("Bis (UTC)") as HTMLInputElement;

    // Ungueltig: Ende liegt nicht nach dem Beginn.
    fireEvent.change(from, { target: { value: "2026-11-15T00:00" } });
    fireEvent.change(to, { target: { value: "2026-11-01T00:00" } });
    await user.click(screen.getByRole("button", { name: "Anwenden" }));
    const invalidAlert = await screen.findByRole("alert");
    expect(invalidAlert.getAttribute("data-range-state")).toBe("invalid");
    expect(invalidAlert.textContent).toContain(
      "Das Ende muss nach dem Beginn liegen",
    );
    expect(requests).toHaveLength(0);

    // Zu lang: mehr als 31 Tage; unterscheidbar vom ungueltigen Zeitraum.
    fireEvent.change(from, { target: { value: "2026-09-01T00:00" } });
    fireEvent.change(to, { target: { value: "2026-11-15T00:00" } });
    await user.click(screen.getByRole("button", { name: "Anwenden" }));
    const tooLongAlert = await screen.findByRole("alert");
    expect(tooLongAlert.getAttribute("data-range-state")).toBe("too_long");
    expect(tooLongAlert.textContent).toContain("höchstens 31 Tage");
    expect(requests).toHaveLength(0);

    // Leer: gueltiger Zeitraum ohne Wiedergaben und ohne Qualitaetswerte.
    fireEvent.change(from, { target: { value: "2026-11-08T00:00" } });
    fireEvent.change(to, { target: { value: "2026-11-15T00:00" } });
    await user.click(screen.getByRole("button", { name: "Anwenden" }));
    await screen.findByText("Keine Statistikdaten im gewählten Zeitraum.");
    const pageRegion = screen.getByRole("region", { name: "Statistik" });
    expect(pageRegion.getAttribute("data-page-state")).toBe("empty");
    expect(
      screen.getByText("Keine Wiedergaben im gewählten Zeitraum."),
    ).toBeTruthy();
    expect(
      screen.getByText("Keine Gerätequalitätswerte im gewählten Zeitraum."),
    ).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(requests).toHaveLength(1);

    // Unvollstaendig: eigener Status, Gruende und fehlende Tage.
    await user.click(screen.getByRole("button", { name: "Anwenden" }));
    await screen.findByText("Status: Unvollständig");
    expect(screen.getByText("Rollup für einen Tag fehlt.")).toBeTruthy();
    expect(screen.getByText("2026-11-10: keine Rohdaten vorhanden")).toBeTruthy();
    expect(pageRegion.getAttribute("data-page-state")).toBe("ready");
    expect(
      pageRegion.querySelector('[data-completeness="incomplete"]'),
    ).not.toBeNull();
    expect(screen.getByText("Teil-Geraet")).toBeTruthy();
    expect(requests).toHaveLength(2);
  });
});

