import { UnavailablePage } from "./UnavailablePage";

/**
 * Austauschbarer Seitenplatz der Taxi-Seite. CX-037 liefert hier den
 * eigentlichen Inhalt; bis dahin bleibt es beim klaren Platzhalter.
 */
export function TaxiPageSlot() {
  return <UnavailablePage title="Taxis" />;
}
