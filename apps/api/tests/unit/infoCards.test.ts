/** Info-Karten: Auswertung, Ausfallverhalten und geschuetzte Route; synthetisch, ohne Netz. */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { ApiError, registerErrorHandler } from "../../src/http/errors.js";
import type { DeviceAuthService } from "../../src/modules/deviceAuth/service.js";
import {
  DEVICE_INFO_PATH,
  InfoCardService,
  NEWS_URL,
  WEATHER_URL,
  registerInfoCardRoute,
} from "../../src/modules/infoCards/index.js";
import { parseHeadlines, parseWeather } from "../../src/modules/infoCards/sources.js";

const NOW = new Date("2026-11-24T18:00:00.000Z");

function weather(): Record<string, unknown> {
  const data = (values: unknown[]): unknown => ({ data: values });
  return {
    timestamps: ["2026-11-24T18:00+00:00", "2026-11-24T19:00+00:00", "2026-11-24T20:00+00:00", "x"],
    features: [{ properties: { parameters: {
      "2t": data([-0.4, 3.6, null, 1]),
      tcc: data([0, 80, 10, 1]),
      rain: data([0, 0.5, 0, 0]),
      sf: data([0, 0, 0, 0]),
    } } }],
  };
}

function item(title: string, created: string): string {
  return `<item><title>${title}</title><dcterms:created>${created}</dcterms:created></item>`;
}

const FEED = "<rss><channel><title>Kopf</title>" +
  item("Aeltere, aber noch gueltige Meldung", "2026-11-24T08:00:00+01:00") +
  item("Neue Volksschule f&#252;r Margareten &amp; Wieden", "2026-11-24T15:42:00+01:00") +
  item("NEUE Volksschule f&#252;r Margareten &amp; Wieden", "2026-11-24T15:41:00+01:00") +
  item("Termine am 25. November 2026", "2026-11-24T13:00:00+01:00") +
  item("Viel zu alte Meldung aus Wien", "2026-11-20T13:00:00+01:00") +
  item("Meldung ohne Datum in Wien", "unbekannt") +
  item("Kurz", "2026-11-24T13:00:00+01:00") +
  "</channel></rss>";

describe("Info-Karten", () => {
  it("liest vollstaendige Wetterstunden und verwirft unvollstaendige", () => {
    expect(parseWeather(weather())).toEqual([
      { at: "2026-11-24T18:00:00.000Z", temperature: 0, condition: "clear" },
      { at: "2026-11-24T19:00:00.000Z", temperature: 4, condition: "rain" },
    ]);
    for (const bad of [null, [], {}, { timestamps: [], features: [] }]) expect(parseWeather(bad)).toEqual([]);
  });

  it("liefert neueste eindeutige Schlagzeilen ohne Termine, alte und kurze Titel", () => {
    expect(parseHeadlines(FEED, NOW).map((entry) => entry.title)).toEqual([
      "Neue Volksschule für Margareten & Wieden",
      "Aeltere, aber noch gueltige Meldung",
    ]);
  });

  it("behaelt bei Ausfall den letzten Stand bis zum Ablauf", async () => {
    let now = NOW;
    let broken = false;
    const service = new InfoCardService(() => now, async (url) => {
      if (broken) throw new Error("aus");
      return url === WEATHER_URL ? JSON.stringify(weather()) : FEED;
    });
    expect(service.current()).toEqual({ schema_version: 1, weather: null, news: null });
    expect(await service.refresh()).toBe(true);
    broken = true;
    expect(await service.refresh()).toBe(false);
    expect(service.current().weather?.points).toHaveLength(2);
    expect(service.current().news?.source).toContain("Stadt Wien");
    now = new Date(NOW.getTime() + 24 * 3_600_000);
    expect(service.current()).toEqual({ schema_version: 1, weather: null, news: null });
  });

  it("eine defekte Quelle laesst die andere unberuehrt", async () => {
    const service = new InfoCardService(() => NOW, async (url) => (url === NEWS_URL ? FEED : "kein json"));
    expect(await service.refresh()).toBe(false);
    expect(service.current().weather).toBeNull();
    expect(service.current().news?.items).toHaveLength(2);
  });

  it("verlangt die Geraeteanmeldung", async () => {
    const app = Fastify();
    registerErrorHandler(app);
    const deviceAuth = {
      authenticate: async () => { throw ApiError.unauthorized(); },
    } as unknown as DeviceAuthService;
    registerInfoCardRoute(app, { service: new InfoCardService(() => NOW), deviceAuth });
    const response = await app.inject({ method: "GET", url: DEVICE_INFO_PATH, headers: { "x-gt-ads-api-version": "1" } });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
