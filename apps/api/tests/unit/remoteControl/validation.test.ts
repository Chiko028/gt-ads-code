import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createRemoteControlService,
  normalizeAcknowledgeAppliedInput,
  normalizeSetDesiredPauseInput,
  RemoteControlValidationError,
  type TaxiDirectory,
} from "../../../src/modules/remoteControl/index.js";

const unusedDirectory: TaxiDirectory = {
  async listActiveDeviceIds() {
    return [];
  },
  async findDeviceAssignment() {
    return null;
  },
};

describe("CX-012 Eingabepruefung", () => {
  it("normalisiert gueltige Verwaltungsaenderungen", () => {
    const commandId = randomUUID();
    const normalized = normalizeSetDesiredPauseInput({
      actor: { id: "  SYN-ADMIN-CX012  ", type: "admin" },
      taxiId: "  SYN-CX-012-TAXI-A ",
      commandId: commandId.toUpperCase(),
      expectedRevision: 0,
      desiredPaused: true,
    });

    expect(normalized).toEqual({
      actorId: "SYN-ADMIN-CX012",
      taxiId: "SYN-CX-012-TAXI-A",
      commandId,
      expectedRevision: 0,
      desiredPaused: true,
    });
  });

  it("weist ungueltige Revision, command_id, Ursprung und Zustand ab", () => {
    const base = {
      actor: { id: "SYN-ADMIN-CX012", type: "admin" as const },
      taxiId: "SYN-CX-012-TAXI-A",
      commandId: randomUUID(),
      expectedRevision: 0,
      desiredPaused: true,
    };

    expect(() =>
      normalizeSetDesiredPauseInput({ ...base, expectedRevision: -1 }),
    ).toThrow(RemoteControlValidationError);
    expect(() =>
      normalizeSetDesiredPauseInput({ ...base, expectedRevision: 1.5 }),
    ).toThrow(RemoteControlValidationError);
    expect(() =>
      normalizeSetDesiredPauseInput({ ...base, commandId: "keine-uuid" }),
    ).toThrow(RemoteControlValidationError);
    expect(() =>
      normalizeSetDesiredPauseInput({ ...base, taxiId: "   " }),
    ).toThrow(RemoteControlValidationError);
    expect(() =>
      normalizeSetDesiredPauseInput({
        ...base,
        actor: { id: "SYN-ADMIN", type: "device" as "admin" },
      }),
    ).toThrow(RemoteControlValidationError);
    expect(() =>
      normalizeSetDesiredPauseInput({
        ...base,
        desiredPaused: "true" as unknown as boolean,
      }),
    ).toThrow(RemoteControlValidationError);
  });

  it("prueft Bestaetigungen auf UUID und angebotene Revision", () => {
    const deviceId = randomUUID();
    expect(
      normalizeAcknowledgeAppliedInput({
        deviceId,
        taxiId: "SYN-CX-012-TAXI-A",
        revision: 1,
      }),
    ).toEqual({
      deviceId,
      taxiId: "SYN-CX-012-TAXI-A",
      revision: 1,
    });
    expect(() =>
      normalizeAcknowledgeAppliedInput({
        deviceId,
        taxiId: "SYN-CX-012-TAXI-A",
        revision: 0,
      }),
    ).toThrow(RemoteControlValidationError);
  });

  it("weist ungueltige Service-Eingaben vor jedem Datenbankzugriff ab", async () => {
    const service = createRemoteControlService({
      pool: {
        connect() {
          throw new Error("Datenbank darf nicht beruehrt werden");
        },
      },
      directory: unusedDirectory,
    });

    await expect(
      service.setDesiredPause({
        actor: { id: "SYN-ADMIN-CX012" },
        taxiId: "SYN-CX-012-TAXI-A",
        commandId: "keine-uuid",
        expectedRevision: 0,
        desiredPaused: true,
      }),
    ).rejects.toBeInstanceOf(RemoteControlValidationError);
    await expect(service.getPendingForDevice("keine-uuid")).rejects.toBeInstanceOf(
      RemoteControlValidationError,
    );
  });
});
