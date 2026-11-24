/**
 * Info-Karten: reine Auswertung der freien Quellen, ohne I/O.
 *  - Wetter: GeoSphere Austria Data Hub (CC BY 4.0), Punktvorhersage Wien.
 *  - Schlagzeilen: Presse-Service der Stadt Wien, nur Text, keine Bilder.
 */
export type WeatherCondition = "clear" | "partly" | "cloudy" | "rain" | "snow";

export interface WeatherPoint {
  at: string;
  temperature: number;
  condition: WeatherCondition;
}

export interface Headline {
  title: string;
}

const MAX_POINTS = 72;
const MAX_HEADLINES = 6;
const MIN_TITLE = 10;
const MAX_TITLE = 140;
const MAX_NEWS_AGE_MS = 36 * 3_600_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numbersOf(parameters: Record<string, unknown>, name: string): unknown[] {
  const entry = parameters[name];
  return isRecord(entry) && Array.isArray(entry.data) ? entry.data : [];
}

function conditionOf(cloud: number, rain: number, snow: number): WeatherCondition {
  if (snow >= 0.1) return "snow";
  if (rain >= 0.1) return "rain";
  if (cloud < 25) return "clear";
  return cloud < 70 ? "partly" : "cloudy";
}

/** Liest stuendliche Punkte; unvollstaendige Stunden werden ausgelassen. */
export function parseWeather(input: unknown): WeatherPoint[] {
  if (!isRecord(input) || !Array.isArray(input.timestamps) || !Array.isArray(input.features)) return [];
  const feature: unknown = input.features[0];
  const properties = isRecord(feature) ? feature.properties : null;
  const parameters = isRecord(properties) ? properties.parameters : null;
  if (!isRecord(parameters)) return [];
  const temperature = numbersOf(parameters, "2t");
  const cloud = numbersOf(parameters, "tcc");
  const rain = numbersOf(parameters, "rain");
  const snow = numbersOf(parameters, "sf");
  const points: WeatherPoint[] = [];
  input.timestamps.slice(0, MAX_POINTS).forEach((timestamp: unknown, index: number) => {
    const at = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
    const values = [temperature[index], cloud[index], rain[index], snow[index]];
    if (!Number.isFinite(at) || !values.every((v) => typeof v === "number" && Number.isFinite(v))) return;
    const [t, c, r, s] = values as [number, number, number, number];
    points.push({
      at: new Date(at).toISOString(),
      temperature: Math.round(t) + 0,
      condition: conditionOf(c, r, s),
    });
  });
  return points;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function decodeText(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, code: string) => {
      if (!code.startsWith("#")) return ENTITIES[code.toLowerCase()] ?? whole;
      const value = /^#x/i.test(code) ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
    })
    .replace(/<[^>]*>/g, " ")
    // Steuer- und Richtungszeichen gehoeren nicht auf einen Werbebildschirm.
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagOf(item: string, name: string): string | null {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(item);
  return match?.[1] ?? null;
}

/** Neueste eindeutige Schlagzeilen; Terminlisten, alte und unpassend lange Titel entfallen. */
export function parseHeadlines(xml: string, now: Date): Headline[] {
  const seen = new Set<string>();
  const result: Array<{ title: string; at: number }> = [];
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)) {
    const item = match[1] ?? "";
    const title = decodeText(tagOf(item, "title") ?? "");
    // pubDate des Feeds nennt Ortszeit faelschlich als GMT; dcterms:created traegt den Versatz.
    const at = Date.parse((tagOf(item, "dcterms:created") ?? "").trim());
    const age = now.getTime() - at;
    if (!Number.isFinite(at) || age > MAX_NEWS_AGE_MS || age < -3_600_000) continue;
    if (title.length < MIN_TITLE || title.length > MAX_TITLE) continue;
    if (/^Termine\b/i.test(title)) continue;
    const key = title.toLocaleLowerCase("de");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ title, at });
  }
  return result
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_HEADLINES)
    .map(({ title }) => ({ title }));
}
