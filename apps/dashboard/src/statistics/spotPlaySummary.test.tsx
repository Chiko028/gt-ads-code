/**
 * CX-161: Tests der Monatsuebersicht auf der Statistikseite.
 *
 * Keine Netzverbindung: die Monatsauswertung wird ueber injizierte Clients
 * bzw. ein injiziertes fetch geprueft. Die Tests decken Kennzahlen,
 * Monatswechsel, leeren Monat, Fehler ohne alte Zahlen, CSV-Inhalt und die
 * exakte Monatsroute ab.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AdminApiError } from "../admin/adminApi";
import type { FetchLike } from "../admin/adminApi";
import { StatisticsPage } from "./StatisticsPage";
import type { StatisticsClient } from "./statisticsApi";
import {
  SpotPlaySummary,
  buildCustomerCsv,
  formatMinutes,
  formatScreenTime,
  lastTwelveMonths,
} from "./SpotPlaySummary";
import type {
  SpotPlaySummary as SpotPlaySummaryData,
  SpotPlaySummaryClient,
} from "./spotPlaysApi";
import {
  createSpotPlaySummaryClient,
  parseSpotPlaySummary,
} from "./spotPlaysApi";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});

const NOW = new Date("2026-11-15T12:00:00.000Z");

function summary(
  overrides: Partial<SpotPlaySummaryData> = {},
): SpotPlaySummaryData {
  return {
    month: "2026-11",
    totals: { spots: 1234, playedMs: 4321 * 60_000, taxis: 2 },
    perTaxi: [
      {
        taxiId: "taxi-1",
        displayName: "Taxi Eins",
        spots: 8,
        playedMs: 5.5 * 60_000,
      },
      {
        taxiId: "taxi-2",
        displayName: null,
        spots: 20,
        playedMs: 90 * 60_000,
      },
    ],
    perMedia: [
      {
        mediaId: "media-1",
        displayName: "Spot A",
        customerName: "Kunde A",
        spots: 10,
        playedMs: 90 * 60_000,
      },
    ],
    lastReceivedAt: null,
    ...overrides,
  };
}

interface CapturedSummaryClient {
  readonly client: SpotPlaySummaryClient;
  readonly months: string[];
}

function captureClient(
  handler: (month: string, index: number) => Promise<SpotPlaySummaryData>,
): CapturedSummaryClient {
  const months: string[] = [];
  const client: SpotPlaySummaryClient = {
    getMonthlySummary(month) {
      months.push(month);
      return handler(month, months.length - 1);
    },
  };
  return { client, months };
}

function renderSummary(client: SpotPlaySummaryClient): void {
  render(<SpotPlaySummary client={client} now={NOW} />);
}

describe("CX-161 Monatsuebersicht der Abspielnachweise", () => {
  it("zeigt Kennzahlen, Minuten je Taxi und Bildschirmzeit je Video", async () => {
    const { client } = captureClient(async () => summary());
    renderSummary(client);

    const region = await screen.findByRole("region", {
      name: "Abspielnachweis",
    });
    await within(region).findByText("Spots gesamt");

    // Kennzahlen: Spots, Werbeminuten mit Tausenderpunkt, Taxis.
    expect(
      within(region).getByText("Spots gesamt").nextElementSibling?.textContent,
    ).toBe("1234");
    expect(
      within(region).getByText("Werbeminuten").nextElementSibling?.textContent,
    ).toBe("4.321");
    expect(
      within(region).getByText("Taxis mit Werbung").nextElementSibling
        ?.textContent,
    ).toBe("2");

    // Minuten je Taxi: unter 10 Minuten mit Nachkommastelle.
    const taxiTable = within(region).getByRole("table", { name: "Pro Taxi" });
    const firstTaxi = within(taxiTable).getByRole("row", {
      name: /Taxi Eins/,
    });
    expect(within(firstTaxi).getAllByRole("cell")[2]?.textContent).toBe("5,5");

    const unnamedTaxi = within(taxiTable).getByRole("row", {
      name: /taxi-2/,
    });
    expect(within(unnamedTaxi).getAllByRole("cell")[2]?.textContent).toBe("90");

    // Bildschirmzeit je Werbevideo: ab einer Stunde zusaetzlich in Stunden.
    const mediaTable = within(region).getByRole("table", {
      name: "Pro Werbevideo",
    });
    const mediaRow = within(mediaTable).getByRole("row", {
      name: /Kunde A/,
    });
    const mediaCells = within(mediaRow).getAllByRole("cell");
    expect(mediaCells[0]?.textContent).toBe("Kunde A");
    expect(mediaCells[1]?.textContent).toBe("Spot A");
    expect(mediaCells[3]?.textContent).toBe("90 min (1,5 h)");

    expect(
      within(region).getByRole("button", { name: "CSV-Kundenbericht" }),
    ).toBeTruthy();
  });

  it("laedt beim Monatswechsel neu und ersetzt die alten Zahlen", async () => {
    const { client, months } = captureClient(async (month) =>
      summary({
        month,
        totals: {
          spots: month === "2026-11" ? 1234 : 7,
          playedMs: 4321 * 60_000,
          taxis: 2,
        },
        perMedia: [
          {
            mediaId: "media-1",
            displayName: "Spot A",
            customerName: "Kunde " + month,
            spots: month === "2026-11" ? 10 : 1,
            playedMs: 90 * 60_000,
          },
        ],
      }),
    );
    renderSummary(client);

    const region = await screen.findByRole("region", {
      name: "Abspielnachweis",
    });
    await within(region).findByText("Kunde 2026-11");
    expect(months).toEqual(["2026-11"]);

    const select = within(region).getByLabelText("Monat") as HTMLSelectElement;
    expect(select.value).toBe("2026-11");

    fireEvent.change(select, { target: { value: "2026-10" } });

    await within(region).findByText("Kunde 2026-10");
    await waitFor(() => expect(months).toEqual(["2026-11", "2026-10"]));
    expect(select.value).toBe("2026-10");
    expect(within(region).queryByText("Kunde 2026-11")).toBeNull();
    expect(
      within(region).getByText("Spots gesamt").nextElementSibling?.textContent,
    ).toBe("7");
  });

  it("zeigt einen leeren Monat verstaendlich und ohne Tabellen", async () => {
    const { client } = captureClient(async () =>
      summary({
        totals: { spots: 0, playedMs: 0, taxis: 0 },
        perTaxi: [],
        perMedia: [],
      }),
    );
    renderSummary(client);

    const region = await screen.findByRole("region", {
      name: "Abspielnachweis",
    });
    expect(
      await within(region).findByText(/Keine Spots im gewählten Monat/),
    ).toBeTruthy();
    expect(region.getAttribute("data-spot-summary-state")).toBe("empty");
    expect(within(region).queryAllByRole("table")).toHaveLength(0);
    expect(
      within(region).queryByRole("button", { name: "CSV-Kundenbericht" }),
    ).toBeNull();
  });

  it("zeigt bei einem Fehler keine alten Zahlen", async () => {
    const { client } = captureClient(async (_month, index) => {
      if (index === 0) {
        return summary();
      }
      throw new AdminApiError("server", "Monatsauswertung nicht verfügbar.");
    });
    renderSummary(client);

    const region = await screen.findByRole("region", {
      name: "Abspielnachweis",
    });
    await within(region).findByText("Kunde A");
    expect(within(region).getAllByRole("table")).toHaveLength(2);

    fireEvent.change(
      within(region).getByLabelText("Monat") as HTMLSelectElement,
      { target: { value: "2026-10" } },
    );

    const alert = await within(region).findByRole("alert");
    expect(alert.textContent).toContain("Monatsauswertung nicht verfügbar.");
    expect(within(region).queryByText("Kunde A")).toBeNull();
    expect(within(region).queryByText("Spots gesamt")).toBeNull();
    expect(within(region).queryAllByRole("table")).toHaveLength(0);
    expect(region.getAttribute("data-spot-summary-state")).toBe("error");
  });

  it("erzeugt einen CSV-Kundenbericht mit Semikolon und BOM", () => {
    const csv = buildCustomerCsv(
      summary({
        perMedia: [
          {
            mediaId: "media-1",
            displayName: "Spot A",
            customerName: "Kunde A",
            spots: 10,
            playedMs: 90 * 60_000,
          },
          {
            mediaId: "media-2",
            displayName: "Spot B",
            customerName: "Kunde A",
            spots: 2,
            playedMs: 30 * 60_000,
          },
          {
            mediaId: "media-3",
            displayName: "Spot C",
            customerName: null,
            spots: 1,
            playedMs: 5.5 * 60_000,
          },
        ],
      }),
    );

    expect(csv.startsWith("\uFEFF")).toBe(true);
    const lines = csv.replace(/^\uFEFF/, "").trimEnd().split("\n");
    expect(lines[0]).toBe("Kunde;Spots;Werbeminuten");
    expect(lines).toContain("Kunde A;12;120,0");
    expect(lines).toContain("unbekannt;1;5,5");
    expect(lines.every((line) => line.split(";").length === 3)).toBe(true);
  });

  it("formatiert Minuten mit Tausenderpunkt und unter zehn Minuten genau eine Nachkommastelle", () => {
    expect(formatMinutes(1234 * 60_000)).toBe("1.234");
    expect(formatMinutes(5.5 * 60_000)).toBe("5,5");
    expect(formatScreenTime(59 * 60_000)).toBe("59 min");
    expect(formatScreenTime(90 * 60_000)).toBe("90 min (1,5 h)");
  });

  it("ruft genau die Monatsroute der Admin-API auf", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            month: "2026-11",
            totals: { spots: 12, played_ms: 5_400_000, taxis: 2 },
            per_taxi: [
              {
                taxi_id: "taxi-1",
                display_name: "Taxi Eins",
                spots: 8,
                played_ms: 330_000,
              },
            ],
            per_media: [
              {
                media_id: "media-1",
                display_name: "Spot A",
                customer_name: "Kunde A",
                spots: 10,
                played_ms: 5_400_000,
              },
            ],
            last_received_at: "2026-11-30T23:00:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    };

    const client = createSpotPlaySummaryClient({ fetchImpl });
    const data = await client.getMonthlySummary!("2026-11");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "/v1/admin/spot-plays/summary?month=2026-11",
    );
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.credentials).toBe("same-origin");
    expect(data.month).toBe("2026-11");
    expect(data.totals).toEqual({ spots: 12, playedMs: 5_400_000, taxis: 2 });
    expect(data.perTaxi[0]?.displayName).toBe("Taxi Eins");
    expect(data.perMedia[0]?.customerName).toBe("Kunde A");
  });

  it("weist strukturell falsche Antworten und einen falschen Antwortmonat zurueck", () => {
    expect(() =>
      parseSpotPlaySummary({
        month: "2026-11",
        totals: { spots: 1, played_ms: "12", taxis: 1 },
        per_taxi: [],
        per_media: [],
        last_received_at: null,
      }),
    ).toThrow(AdminApiError);
    expect(() =>
      parseSpotPlaySummary(
        {
          month: "2026-12",
          totals: { spots: 1, played_ms: 12, taxis: 1 },
          per_taxi: [],
          per_media: [],
          last_received_at: null,
        },
        "2026-11",
      ),
    ).toThrow(AdminApiError);
  });

  it("zeigt die Uebersicht oberhalb der eingeklappten technischen Details", async () => {
    const summaryClient = captureClient(async () => summary()).client;
    const statisticsClient: StatisticsClient = {
      getStatistics: () => Promise.reject(new Error("nicht verwendet")),
    };
    render(
      <StatisticsPage
        client={statisticsClient}
        spotPlaysClient={summaryClient}
        now={NOW}
      />,
    );

    const region = await screen.findByRole("region", {
      name: "Abspielnachweis",
    });
    const detailsSummary = screen.getByText(
      /Technische Details \(Gerätequalität, Messdefinition\)/,
    );
    const details = detailsSummary.closest("details");
    expect(details).not.toBeNull();
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(
      region.compareDocumentPosition(details as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Statistik" })).toBeTruthy();

    detailsSummary.click();
    expect((details as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByRole("button", { name: "Anwenden" })).toBeTruthy();
  });

  it("zeigt ohne eigenen Client keine Uebersicht, wenn ein Statistikclient injiziert ist", async () => {
    const statisticsClient: StatisticsClient = {
      getStatistics: () => Promise.reject(new Error("nicht verwendet")),
    };
    render(<StatisticsPage client={statisticsClient} now={NOW} />);
    await screen.findByRole("heading", { name: "Statistik" });
    expect(
      screen.queryByRole("region", { name: "Abspielnachweis" }),
    ).toBeNull();
  });

  it("bietet die letzten zwoelf Monate ab dem aktuellen Monat an", () => {
    const options = lastTwelveMonths(NOW);
    expect(options).toHaveLength(12);
    expect(options[0]?.value).toBe("2026-11");
    expect(options[11]?.value).toBe("2025-12");
  });
});
