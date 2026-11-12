/** CX-012: typisierte Fehler des taxiweiten Pausenauftragskerns. */

export class RemoteControlError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Eingabe ist ungueltig; es wurde nichts geschrieben. */
export class RemoteControlValidationError extends RemoteControlError {}

/**
 * Dieselbe command_id wurde mit abweichendem kanonischem Inhalt verwendet.
 * Idempotenz wird vor der Revisionspruefung ausgewertet; nichts wird mutiert.
 */
export class RemoteControlCommandConflictError extends RemoteControlError {
  readonly commandId: string;

  constructor(commandId: string) {
    super(
      "command_id " +
        commandId +
        " ist bereits mit anderem kanonischen Inhalt gespeichert.",
    );
    this.commandId = commandId;
  }
}

/** expected_revision passt nicht zur aktuellen Sollrevision des Taxis. */
export class RemoteControlRevisionConflictError extends RemoteControlError {
  readonly expectedRevision: number;
  readonly currentRevision: number;

  constructor(expectedRevision: number, currentRevision: number) {
    super(
      "Revisionskonflikt: erwartet " +
        expectedRevision +
        ", aktuell " +
        currentRevision +
        ".",
    );
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}

/** Ein Taxi muss genau zwei eindeutige aktive Tablets besitzen. */
export class RemoteControlTaxiTargetError extends RemoteControlError {
  readonly taxiId: string;
  readonly activeTabletCount: number;

  constructor(taxiId: string, activeTabletCount: number) {
    super(
      "Taxi " +
        taxiId +
        " hat " +
        activeTabletCount +
        " aktive Tablets; erwartet werden genau zwei eindeutige Zuordnungen.",
    );
    this.taxiId = taxiId;
    this.activeTabletCount = activeTabletCount;
  }
}

export type DeviceRejectionReason = "not_assigned" | "inactive" | "revoked";

/** Geraet ist nicht (mehr) aktiv dem angegebenen Taxi zugeordnet. */
export class RemoteControlDeviceRejectedError extends RemoteControlError {
  readonly deviceId: string;
  readonly reason: DeviceRejectionReason;

  constructor(deviceId: string, reason: DeviceRejectionReason) {
    super("Geraet " + deviceId + " ist nicht berechtigt: " + reason + ".");
    this.deviceId = deviceId;
    this.reason = reason;
  }
}

export type AckRejectionReason = "unknown_revision" | "superseded";

/** Bestaetigung bezieht sich nicht auf die aktuell angebotene Revision. */
export class RemoteControlAckRejectedError extends RemoteControlError {
  readonly deviceId: string;
  readonly taxiId: string;
  readonly revision: number;
  readonly reason: AckRejectionReason;

  constructor(
    deviceId: string,
    taxiId: string,
    revision: number,
    reason: AckRejectionReason,
  ) {
    super(
      "Bestaetigung von " +
        deviceId +
        " fuer Taxi " +
        taxiId +
        " Revision " +
        revision +
        " abgewiesen: " +
        reason +
        ".",
    );
    this.deviceId = deviceId;
    this.taxiId = taxiId;
    this.revision = revision;
    this.reason = reason;
  }
}
