/**
 * Port fuer die bestehende Taxi-/Tablet-Zuordnung. CX-012 baut bewusst keine
 * Stammdatenverwaltung: Produktion muss eine vorhandene Zuordnung anbinden,
 * Tests verwenden einen synthetischen Adapter.
 */
export interface TaxiDeviceAssignment {
  deviceId: string;
  taxiId: string;
  active: boolean;
}

export interface TaxiDirectory {
  /** Alle aktiven Tablet-IDs eines Taxis; Duplikate werden vom Dienst entwertet. */
  listActiveDeviceIds(taxiId: string): Promise<readonly string[]>;
  /** Zuordnung eines Geraets oder null, wenn es keinem Taxi zugeordnet ist. */
  findDeviceAssignment(deviceId: string): Promise<TaxiDeviceAssignment | null>;
}
