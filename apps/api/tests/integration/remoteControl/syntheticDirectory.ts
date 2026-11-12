import type {
  TaxiDeviceAssignment,
  TaxiDirectory,
} from "../../../src/modules/remoteControl/index.js";

/**
 * Synthetischer Testadapter fuer die Taxi-/Tablet-Zuordnung. Es gibt in
 * CX-012 keine Stammdatenverwaltung; Produktionszuordnungen werden nicht
 * erfunden.
 */
export class SyntheticTaxiDirectory implements TaxiDirectory {
  private readonly assignments = new Map<string, TaxiDeviceAssignment>();

  assign(deviceId: string, taxiId: string, active = true): void {
    this.assignments.set(deviceId, { deviceId, taxiId, active });
  }

  revoke(deviceId: string): void {
    const assignment = this.assignments.get(deviceId);
    if (assignment !== undefined) {
      this.assignments.set(deviceId, { ...assignment, active: false });
    }
  }

  clear(): void {
    this.assignments.clear();
  }

  async listActiveDeviceIds(taxiId: string): Promise<readonly string[]> {
    return [...this.assignments.values()]
      .filter((assignment) => assignment.taxiId === taxiId && assignment.active)
      .map((assignment) => assignment.deviceId);
  }

  async findDeviceAssignment(
    deviceId: string,
  ): Promise<TaxiDeviceAssignment | null> {
    return this.assignments.get(deviceId) ?? null;
  }
}
