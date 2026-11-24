/**
 * Info-Karten (Wetter Wien, Schlagzeilen) fuer die Tablets.
 *
 * Der Server holt die Quellen alle drei Stunden und haelt den letzten guten
 * Stand im Speicher; Tablets fragen ausschliesslich diesen Server. Faellt eine
 * Quelle aus, bleibt ihr letzter Stand bis zum Ablauf gueltig. Ohne
 * GT_ADS_INFO_CARDS=true gibt es keinen ausgehenden Abruf und leere Karten.
 */
import type { FastifyInstance } from "fastify";
import { createDeviceAuthMiddleware } from "../deviceAuth/middleware.js";
import type { DeviceAuthService } from "../deviceAuth/service.js";
import { parseHeadlines, parseWeather, type Headline, type WeatherPoint } from "./sources.js";

export const DEVICE_INFO_PATH = "/v1/device/info";
export const WEATHER_URL =
  "https://dataset.api.hub.geosphere.at/v1/timeseries/forecast/nwp-v2-1h-1km" +
  "?parameters=2t&parameters=tcc&parameters=rain&parameters=sf&lat_lon=48.2082,16.3738&output_format=geojson";
export const NEWS_URL =
  "https://presse.wien.gv.at/presse/rss/-/asset_publisher/jH1vdQZIY6C9/rss?feedType=RKSuche&meldungen=1&bilder=0&notInit=false";
export const WEATHER_SOURCE = "Datenquelle: GeoSphere Austria - https://data.hub.geosphere.at (CC BY 4.0, bearbeitet)";
export const NEWS_SOURCE = "Quelle: Stadt Wien - presse.wien.gv.at";

const REFRESH_MS = 3 * 3_600_000;
const RETRY_MS = 15 * 60_000;
const VALID_MS = 24 * 3_600_000;
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 2_000_000;

export interface InfoCards {
  schema_version: 1;
  weather: { city: string; valid_until: string; source: string; points: WeatherPoint[] } | null;
  news: { valid_until: string; source: string; items: Headline[] } | null;
}

export type FetchText = (url: string) => Promise<string>;

/** Begrenzter HTTPS-Abruf ohne Weiterleitung auf unsichere Ziele. */
export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "User-Agent": "info-cards/1.0" },
    redirect: "error",
  });
  if (!response.ok || response.body === null) throw new Error("Quelle antwortet nicht");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > MAX_BYTES) throw new Error("Quelle zu gross");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class InfoCardService {
  private weather: InfoCards["weather"] = null;
  private news: InfoCards["news"] = null;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly load: FetchText = fetchText,
  ) {}

  /** Aktualisiert beide Quellen unabhaengig; true, wenn beide gelungen sind. */
  async refresh(): Promise<boolean> {
    const validUntil = new Date(this.now().getTime() + VALID_MS).toISOString();
    const results = await Promise.allSettled([
      this.load(WEATHER_URL).then((text) => {
        const points = parseWeather(JSON.parse(text));
        if (points.length === 0) throw new Error("Wetter leer");
        this.weather = { city: "Wien", valid_until: validUntil, source: WEATHER_SOURCE, points };
      }),
      this.load(NEWS_URL).then((text) => {
        if (!text.includes("<rss")) throw new Error("Kein RSS");
        const items = parseHeadlines(text, this.now());
        this.news = items.length === 0 ? null : { valid_until: validUntil, source: NEWS_SOURCE, items };
      }),
    ]);
    return results.every((result) => result.status === "fulfilled");
  }

  current(): InfoCards {
    const valid = <T extends { valid_until: string }>(card: T | null): T | null =>
      card !== null && Date.parse(card.valid_until) > this.now().getTime() ? card : null;
    return { schema_version: 1, weather: valid(this.weather), news: valid(this.news) };
  }
}

/** Ein Lauf beim Start, danach alle 3 h; nach einem Fehler in 15 min erneut. */
export function startInfoCardRefresh(app: FastifyInstance, service: InfoCardService): void {
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  const tick = async (): Promise<void> => {
    const complete = await service.refresh().catch(() => false);
    if (!complete) app.log.warn("Info-Karten: mindestens eine Quelle nicht verfuegbar");
    if (closed) return;
    timer = setTimeout(() => void tick(), complete ? REFRESH_MS : RETRY_MS);
    timer.unref();
  };
  app.addHook("onReady", async () => {
    void tick();
  });
  app.addHook("onClose", async () => {
    closed = true;
    if (timer !== null) clearTimeout(timer);
  });
}

export function registerInfoCardRoute(
  app: FastifyInstance,
  deps: { service: InfoCardService; deviceAuth: DeviceAuthService },
): void {
  app.get(
    DEVICE_INFO_PATH,
    { preHandler: createDeviceAuthMiddleware(deps.deviceAuth) },
    async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
      return reply.code(200).send(deps.service.current());
    },
  );
}
