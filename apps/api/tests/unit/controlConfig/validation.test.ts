import { describe, expect, it } from "vitest";
import {
  ControlConfigValidationError,
  isPolicyComplete,
  normalizeConfigValues,
  normalizeReadTaxiConfigInput,
  normalizeUpdateTaxiConfigInput,
  type TaxiControlConfigValues,
} from "../../../src/modules/controlConfig/index.js";

const CHANGE_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR = { id: "SYN-CX-013-ADMIN", type: "admin" as const };

function config(
  overrides: Partial<TaxiControlConfigValues> = {},
): TaxiControlConfigValues {
  return {
    gps_mode: "aus",
    pause_max_duration_s: 1234,
    pause_end_on_vehicle_off: true,
    display_run_on_s: 45,
    ...overrides,
  };
}

function updateInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    actor: ACTOR,
    taxi_id: "SYN-CX-013-TAXI-A",
    change_id: CHANGE_ID,
    expected_revision: 0,
    config: config(),
    ...overrides,
  };
}

describe("CX-013 Konfigurationsvalidierung", () => {
  it("akzeptiert eine vollstaendige Konfiguration und normalisiert Actor, Taxi und change_id", () => {
    const normalized = normalizeUpdateTaxiConfigInput({
      ...updateInput(),
      actor: { id: "  SYN-CX-013-ADMIN  " },
      taxi_id: "  SYN-CX-013-TAXI-A  ",
      change_id: "  SYN-CX-013-CHANGE-001  ",
      expected_revision: 7,
    });

    expect(normalized).toEqual({
      actor: { id: "SYN-CX-013-ADMIN", type: "admin" },
      taxi_id: "SYN-CX-013-TAXI-A",
      change_id: "SYN-CX-013-CHANGE-001",
      expected_revision: 7,
      config: config(),
    });
  });

  it("behandelt null als unentschieden und meldet Policy erst bei drei expliziten Werten als vollstaendig", () => {
    const empty = config({
      pause_max_duration_s: null,
      pause_end_on_vehicle_off: null,
      display_run_on_s: null,
    });
    expect(normalizeConfigValues(empty)).toEqual(empty);
    expect(isPolicyComplete(empty)).toBe(false);

    expect(
      isPolicyComplete(
        config({
          pause_max_duration_s: 1,
          pause_end_on_vehicle_off: false,
          display_run_on_s: 0,
        }),
      ),
    ).toBe(true);

    for (const partial of [
      { pause_max_duration_s: null },
      { pause_end_on_vehicle_off: null },
      { display_run_on_s: null },
    ]) {
      expect(isPolicyComplete(config(partial))).toBe(false);
    }
  });

  const invalidConfigs: Array<[string, unknown]> = [
    ["negative Pausenmaximaldauer", config({ pause_max_duration_s: -1 })],
    ["Pausenmaximaldauer null Sekunden", config({ pause_max_duration_s: 0 })],
    ["nicht ganzzahlige Pausenmaximaldauer", config({ pause_max_duration_s: 1.5 })],
    ["Pausenmaximaldauer NaN", config({ pause_max_duration_s: Number.NaN })],
    ["Pausenmaximaldauer Infinity", config({ pause_max_duration_s: Number.POSITIVE_INFINITY })],
    [
      "Pausenmaximaldauer ausserhalb sicherer Ganzzahlen",
      config({ pause_max_duration_s: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    ["negativer Display-Nachlauf", config({ display_run_on_s: -1 })],
    ["nicht ganzzahliger Display-Nachlauf", config({ display_run_on_s: 2.5 })],
    ["Display-Nachlauf NaN", config({ display_run_on_s: Number.NaN })],
    ["Display-Nachlauf Infinity", config({ display_run_on_s: Number.POSITIVE_INFINITY })],
    [
      "Display-Nachlauf ausserhalb sicherer Ganzzahlen",
      config({ display_run_on_s: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    [
      "Pause-ende-bei-Fahrzeug-aus ist kein Boolean",
      config({ pause_end_on_vehicle_off: "true" as unknown as boolean }),
    ],
    ["GPS an", config({ gps_mode: "an" as unknown as "aus" })],
    ["GPS lokale Gebietserkennung", config({ gps_mode: "lokal_gebiet" as unknown as "aus" })],
    ["GPS Uebermittlung", config({ gps_mode: "uebermittlung" as unknown as "aus" })],
    ["GPS gross geschrieben", config({ gps_mode: "AUS" as unknown as "aus" })],
    ["GPS null", config({ gps_mode: null as unknown as "aus" })],
    [
      "unbekanntes Konfigurationsfeld",
      { ...config(), approval_reference: "SYN-CX-013-Freigabe" },
    ],
    [
      "unbekanntes Standortfeld",
      { ...config(), latitude: 48.2082 },
    ],
    [
      "fehlendes Feld",
      {
        gps_mode: "aus",
        pause_max_duration_s: 1234,
        pause_end_on_vehicle_off: true,
      },
    ],
    ["kein Objekt", null],
  ];

  it.each(invalidConfigs)("lehnt %s ab", (_label, value) => {
    expect(() => normalizeConfigValues(value)).toThrow(
      ControlConfigValidationError,
    );
  });

  const invalidInputs: Array<[string, unknown]> = [
    ["unbekanntes Top-Level-Feld", updateInput({ gps_approval: { granted: true } })],
    ["behauptete Freigabe", updateInput({ legal_approval: "SYN-CX-013" })],
    ["leere change_id", updateInput({ change_id: "   " })],
    ["fehlende change_id", updateInput({ change_id: undefined })],
    ["negative expected_revision", updateInput({ expected_revision: -1 })],
    ["nicht ganzzahlige expected_revision", updateInput({ expected_revision: 1.5 })],
    ["unsichere expected_revision", updateInput({ expected_revision: Number.MAX_SAFE_INTEGER + 1 })],
    ["fehlende Konfiguration", updateInput({ config: undefined })],
    ["fehlender Actor", updateInput({ actor: null })],
    ["Actor ohne ID", updateInput({ actor: { type: "admin" } })],
    ["Geraete-Actor", updateInput({ actor: { id: "SYN-GERAET", type: "device" } })],
    ["unbekanntes Actor-Feld", updateInput({ actor: { ...ACTOR, role: "root" } })],
    ["fehlendes taxi_id", updateInput({ taxi_id: "   " })],
  ];

  it.each(invalidInputs)("lehnt Update-Eingabe ab: %s", (_label, value) => {
    expect(() => normalizeUpdateTaxiConfigInput(value)).toThrow(
      ControlConfigValidationError,
    );
  });

  it("akzeptiert beim Lesen nur Actor und taxi_id", () => {
    expect(
      normalizeReadTaxiConfigInput({ actor: ACTOR, taxi_id: "SYN-CX-013-TAXI-A" }),
    ).toEqual({ actor: ACTOR, taxi_id: "SYN-CX-013-TAXI-A" });

    expect(() =>
      normalizeReadTaxiConfigInput({
        actor: ACTOR,
        taxi_id: "SYN-CX-013-TAXI-A",
        gps_approval: true,
      }),
    ).toThrow(ControlConfigValidationError);
  });

  it("akzeptiert null fuer alle drei offenen Parameter ohne Defaults", () => {
    const normalized = normalizeUpdateTaxiConfigInput(
      updateInput({
        config: config({
          pause_max_duration_s: null,
          pause_end_on_vehicle_off: null,
          display_run_on_s: null,
        }),
      }),
    );
    expect(normalized.config).toEqual({
      gps_mode: "aus",
      pause_max_duration_s: null,
      pause_end_on_vehicle_off: null,
      display_run_on_s: null,
    });
  });
});
