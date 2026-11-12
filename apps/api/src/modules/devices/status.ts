/**
 * Statusableitung fuer das Dashboard (SPEZIFIKATION.md Abschnitt 6,
 * API-VERTRAG.md Abschnitt 5, AC-09/AC-10).
 *
 * Der Status wird zur Lesezeit aus der Serverzeit und `last_seen_at`
 * berechnet und nie gespeichert. Es gibt bewusst nur zwei Werte; Texte wie
 * "defekt" oder "ausgeschaltet" sind untersagt.
 */

/** Verbindungswert laut API-VERTRAG.md Abschnitt 5. */
export type DeviceConnectivity = "reachable" | "last_seen";

export interface ConnectivityInput {
  /** Serverzeitpunkt des letzten authentifizierten Kontakts. */
  lastSeenAt: Date;
  /** Aktuelle Serverzeit (nicht Geraetezeit). */
  serverTime: Date;
  /** T_online in Sekunden (GT_ADS_ONLINE_THRESHOLD_S). */
  onlineThresholdSeconds: number;
}

/**
 * `reachable`, wenn `serverTime - lastSeenAt <= T_online`; der Grenzfall
 * "gleich der Schwelle" gilt als erreichbar (API-VERTRAG.md Abschnitt 5).
 *
 * Es werden ausschliesslich absolute Zeitpunkte verglichen. Sommer-/
 * Winterzeitwechsel (Europe/Vienna) veraendern die Differenz daher nicht.
 */
export function deriveConnectivity(input: ConnectivityInput): DeviceConnectivity {
  const threshold = input.onlineThresholdSeconds;
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new RangeError("onlineThresholdSeconds muss eine Zahl >= 0 sein");
  }
  const elapsedMs = input.serverTime.getTime() - input.lastSeenAt.getTime();
  if (!Number.isFinite(elapsedMs)) {
    throw new RangeError("lastSeenAt und serverTime muessen gueltige Zeitpunkte sein");
  }
  return elapsedMs <= threshold * 1000 ? "reachable" : "last_seen";
}

/** Kurzform fuer Aufrufer, die nur ein Boolean benoetigen. */
export function isReachable(input: ConnectivityInput): boolean {
  return deriveConnectivity(input) === "reachable";
}
