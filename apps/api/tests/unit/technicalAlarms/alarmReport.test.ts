import { describe, expect, it } from "vitest";
import {
  ALARM_REPORT_INVALID_ERROR,
  ALARM_REPORT_SCHEMA_VERSION,
  buildAlarmReport,
  serializeAlarmReport,
  type AlarmReport,
  type AlarmReportDeliveryState,
  type AlarmReportInput,
  type InvalidAlarmReport,
  type ValidAlarmReport,
} from "../../../src/modules/technicalAlarms/alarmReport.js";

/** Vollstaendige Feldliste eines gueltigen Berichts. */
const VALID_REPORT_KEYS = [
  "alarmId",
  "deliveredAt",
  "deliveryState",
  "episodeState",
  "errorCode",
  "occurredAt",
  "reportError",
  "resourceId",
  "schemaVersion",
  "valid",
] as const;

const OCCURRED_AT_INPUT = "2026-11-13T09:15:30+01:00";
const OCCURRED_AT_UTC = "2026-11-13T08:15:30.000Z";
const DELIVERED_AT_INPUT = "2026-11-13T09:15:45.25+01:00";
const DELIVERED_AT_UTC = "2026-11-13T08:15:45.250Z";

function settledDelivery(): Record<string, unknown> {
  return {
    state: "delivered",
    deliveryConfirmed: true,
    deliveredAt: DELIVERED_AT_INPUT,
  };
}

function baseInput(): AlarmReportInput {
  return {
    alarmId: "ALM-2026-0001",
    resourceId: "taxi_4711",
    errorCode: "GPS_SIGNAL_LOST",
    episodeState: "open",
    occurredAt: OCCURRED_AT_INPUT,
    delivery: settledDelivery(),
  };
}

/** Baut eine Eingabe mit gezielten Abweichungen, auch ungueltigen Werten. */
function inputWith(overrides: Record<string, unknown>): AlarmReportInput {
  return { ...baseInput(), ...overrides } as AlarmReportInput;
}

function asValid(report: AlarmReport): ValidAlarmReport {
  if (report.valid !== true) {
    throw new Error("Bericht wurde unerwartet als ungueltig abgelehnt");
  }
  return report;
}

function asInvalid(report: AlarmReport): InvalidAlarmReport {
  if (report.valid !== false) {
    throw new Error("Bericht wurde unerwartet als gueltig akzeptiert");
  }
  return report;
}

/** Fester ungueltiger Bericht ohne jeden Eingabewert. */
function expectFixedInvalidReport(report: AlarmReport): InvalidAlarmReport {
  const invalid = asInvalid(report);
  expect(Object.keys(invalid).sort()).toEqual([
    "reportError",
    "schemaVersion",
    "valid",
  ]);
  expect(invalid.schemaVersion).toBe(ALARM_REPORT_SCHEMA_VERSION);
  expect(invalid.reportError).toBe(ALARM_REPORT_INVALID_ERROR);
  expect(JSON.parse(JSON.stringify(invalid))).toEqual(invalid);
  return invalid;
}

describe("alarmReport", () => {
  it("erzeugt fuer einen bestaetigten technischen Fehler mit erfolgreicher Zustellung einen begrenzten JSON-Bericht, und eine behobene Episode bleibt unabhaengig vom Zustellergebnis behoben", () => {
    const report = asValid(buildAlarmReport(baseInput()));

    expect(Object.keys(report).sort()).toEqual([...VALID_REPORT_KEYS].sort());
    expect(report).toEqual({
      schemaVersion: ALARM_REPORT_SCHEMA_VERSION,
      valid: true,
      alarmId: "ALM-2026-0001",
      resourceId: "taxi_4711",
      errorCode: "GPS_SIGNAL_LOST",
      episodeState: "open",
      occurredAt: OCCURRED_AT_UTC,
      deliveryState: "delivered",
      deliveredAt: DELIVERED_AT_UTC,
      reportError: null,
    });

    // JSON-Roundtrip: die serialisierte Form enthaelt genau den Bericht.
    const json = serializeAlarmReport(baseInput());
    expect(JSON.parse(json)).toEqual(report);
    expect(json).toBe(JSON.stringify(report));

    // Behoben und zugestellt sind unabhaengige Zustaende.
    const resolvedButFailed = asValid(
      buildAlarmReport(
        inputWith({
          episodeState: "resolved",
          delivery: { state: "failed" },
        }),
      ),
    );
    expect(resolvedButFailed.valid).toBe(true);
    expect(resolvedButFailed.episodeState).toBe("resolved");
    expect(resolvedButFailed.deliveryState).toBe("failed");
    expect(resolvedButFailed.deliveredAt).toBeNull();
    expect(resolvedButFailed.reportError).toBeNull();
    expect(resolvedButFailed.occurredAt).toBe(OCCURRED_AT_UTC);

    const resolvedAndDelivered = asValid(
      buildAlarmReport(inputWith({ episodeState: "resolved" })),
    );
    expect(resolvedAndDelivered.episodeState).toBe("resolved");
    expect(resolvedAndDelivered.deliveryState).toBe("delivered");
    expect(resolvedAndDelivered.deliveredAt).toBe(DELIVERED_AT_UTC);
  });

  it("stellt ausstehende, wiederholbare, endgueltig fehlgeschlagene, blockierte und unbekannte Zustellungen nie als zugestellt dar und liefert bei fehlenden Pflichtangaben, ungueltigen Zeitpunkten oder widerspruechlichen Nachweisen nur den festen ungueltigen Bericht", () => {
    const notDeliveredCases: Array<{
      name: string;
      delivery: Record<string, unknown> | undefined;
      expectedState: AlarmReportDeliveryState;
    }> = [
      { name: "ausstehend", delivery: { state: "pending" }, expectedState: "pending" },
      {
        name: "wiederholbar",
        delivery: { state: "retryable" },
        expectedState: "retryable",
      },
      { name: "fehlgeschlagen", delivery: { state: "failed" }, expectedState: "failed" },
      { name: "blockiert", delivery: { state: "blocked" }, expectedState: "blocked" },
      { name: "unbekannt", delivery: { state: "unknown" }, expectedState: "unknown" },
      {
        name: "fehlender Status",
        delivery: { deliveryConfirmed: false },
        expectedState: "unknown",
      },
      { name: "fehlender Zustellnachweis", delivery: undefined, expectedState: "unknown" },
    ];

    for (const testCase of notDeliveredCases) {
      const report = asValid(
        buildAlarmReport(inputWith({ delivery: testCase.delivery })),
      );
      expect(report.valid, testCase.name).toBe(true);
      expect(report.deliveryState, testCase.name).toBe(testCase.expectedState);
      expect(report.deliveredAt, testCase.name).toBeNull();
      expect(report.reportError, testCase.name).toBeNull();
    }

    const invalidCases: Array<{
      name: string;
      input: AlarmReportInput;
    }> = [
      { name: "fehlende Alarm-ID", input: inputWith({ alarmId: undefined }) },
      { name: "fehlende Ressourcenkennung", input: inputWith({ resourceId: undefined }) },
      { name: "fehlender Fehlercode", input: inputWith({ errorCode: undefined }) },
      { name: "fehlender Episodenzustand", input: inputWith({ episodeState: undefined }) },
      { name: "fehlender Alarmzeitpunkt", input: inputWith({ occurredAt: undefined }) },
      { name: "unbekannter Episodenzustand", input: inputWith({ episodeState: "closed" }) },
      {
        name: "Alarm-ID mit Leerzeichen",
        input: inputWith({ alarmId: "ALM 2026" }),
      },
      { name: "Alarm-ID mit Umlaut", input: inputWith({ alarmId: "ALM-Ä" }) },
      { name: "leere Ressourcenkennung", input: inputWith({ resourceId: "" }) },
      {
        name: "Fehlercode in Kleinschreibung",
        input: inputWith({ errorCode: "gps_signal_lost" }),
      },
      {
        name: "Fehlercode mit Bindestrich",
        input: inputWith({ errorCode: "GPS-LOST" }),
      },
      {
        name: "nicht existenter Kalendertag",
        input: inputWith({ occurredAt: "2026-02-30T10:00:00Z" }),
      },
      {
        name: "Zeitpunkt ohne Zeitzone",
        input: inputWith({ occurredAt: "2026-11-13T10:00:00" }),
      },
      {
        name: "Zeitpunkt nur mit Datum",
        input: inputWith({ occurredAt: "2026-11-13" }),
      },
      {
        name: "unzulaessiger Monat",
        input: inputWith({ occurredAt: "2026-13-01T00:00:00Z" }),
      },
      {
        name: "unzulaessige Stunde",
        input: inputWith({ occurredAt: "2026-11-13T24:00:00Z" }),
      },
      {
        name: "Zeitpunkt als Zahl",
        input: inputWith({ occurredAt: 1_763_000_000_000 }),
      },
      {
        name: "Zeitpunkt als Freitext",
        input: inputWith({ occurredAt: "gestern abend" }),
      },
      {
        name: "zugestellt ohne Erfolgsnachweis",
        input: inputWith({ delivery: { state: "delivered", deliveredAt: DELIVERED_AT_INPUT } }),
      },
      {
        name: "zugestellt mit Erfolgsnachweis false",
        input: inputWith({
          delivery: {
            state: "delivered",
            deliveryConfirmed: false,
            deliveredAt: DELIVERED_AT_INPUT,
          },
        }),
      },
      {
        name: "zugestellt ohne deliveredAt",
        input: inputWith({ delivery: { state: "delivered", deliveryConfirmed: true } }),
      },
      {
        name: "deliveredAt vor occurredAt",
        input: inputWith({
          delivery: {
            state: "delivered",
            deliveryConfirmed: true,
            deliveredAt: "2026-11-13T08:00:00Z",
          },
        }),
      },
      {
        name: "ungueltiges deliveredAt",
        input: inputWith({
          delivery: {
            state: "delivered",
            deliveryConfirmed: true,
            deliveredAt: "2026-02-31T08:00:00Z",
          },
        }),
      },
      {
        name: "Erfolgsnachweis als Zeichenkette",
        input: inputWith({
          delivery: {
            state: "delivered",
            deliveryConfirmed: "true",
            deliveredAt: DELIVERED_AT_INPUT,
          },
        }),
      },
      {
        name: "ausstehend mit Erfolgsnachweis",
        input: inputWith({ delivery: { state: "pending", deliveryConfirmed: true } }),
      },
      {
        name: "wiederholbar mit deliveredAt",
        input: inputWith({
          delivery: { state: "retryable", deliveredAt: DELIVERED_AT_INPUT },
        }),
      },
      {
        name: "fehlgeschlagen mit Erfolgsnachweis",
        input: inputWith({ delivery: { state: "failed", deliveryConfirmed: true } }),
      },
      {
        name: "blockiert mit deliveredAt",
        input: inputWith({
          delivery: { state: "blocked", deliveredAt: DELIVERED_AT_INPUT },
        }),
      },
      {
        name: "unbekannter Status mit deliveredAt",
        input: inputWith({
          delivery: { state: "unknown", deliveredAt: DELIVERED_AT_INPUT },
        }),
      },
      {
        name: "Zustellnachweis als Zeichenkette",
        input: inputWith({ delivery: "delivered" }),
      },
    ];

    for (const testCase of invalidCases) {
      const report = buildAlarmReport(testCase.input);
      expectFixedInvalidReport(report);
      expect(serializeAlarmReport(testCase.input), testCase.name).toBe(
        JSON.stringify(report),
      );
    }
  });

  it("verwirft zusaetzliche und verschachtelte Details sowie unbekannte Statuswerte und unzulaessige Kennungen, ohne sie als Freitext weiterzugeben", () => {
    const secretMarker = "TOKEN-c0ffee-9f3a";
    const recipientMarker = "recipient-887766";
    const locationMarker = "Standort-Hinterhof-3";
    const urlMarker = "https://alarm.invalid/raw/9f3a";
    const rawEventMarker = "ROHEVENT-9f3a";
    const exceptionMarker = "TypeError: interner Pfad /srv/secret/9f3a";
    const nestedTokenMarker = "NESTED-TOKEN-9f3a";

    const enriched = {
      ...baseInput(),
      token: secretMarker,
      recipientId: recipientMarker,
      location: locationMarker,
      url: urlMarker,
      rawEvents: [{ payload: rawEventMarker }],
      exceptionText: exceptionMarker,
      delivery: {
        ...settledDelivery(),
        token: secretMarker,
        recipientId: recipientMarker,
        location: locationMarker,
        url: urlMarker,
        rawEvent: { payload: rawEventMarker },
        exception: new Error(exceptionMarker),
        detail: { token: nestedTokenMarker },
      },
    } as unknown as AlarmReportInput;

    const report = asValid(buildAlarmReport(enriched));
    const json = serializeAlarmReport(enriched);

    expect(Object.keys(report).sort()).toEqual([...VALID_REPORT_KEYS].sort());
    expect(report.alarmId).toBe("ALM-2026-0001");
    expect(report.deliveryState).toBe("delivered");
    expect(report.deliveredAt).toBe(DELIVERED_AT_UTC);

    for (const marker of [
      secretMarker,
      recipientMarker,
      locationMarker,
      urlMarker,
      rawEventMarker,
      exceptionMarker,
      nestedTokenMarker,
    ]) {
      expect(json).not.toContain(marker);
    }
    expect(json).not.toContain("token");
    expect(json).not.toContain("recipient");
    expect(json).not.toContain("rawEvent");

    // Unbekannte Statuswerte und unzulaessige bzw. ueberlange Kennungen
    // ergeben den festen Fehlerbericht; die Eingabewerte tauchen nicht auf.
    const statusMarker = "STATUS_LEAK_9f3a";
    const overlongId = "A".repeat(65) + "-9f3a";
    const invalidInputs: AlarmReportInput[] = [
      inputWith({ delivery: { state: statusMarker, deliveryConfirmed: true } }),
      inputWith({ alarmId: overlongId }),
      inputWith({ resourceId: "taxi 4711/ä" }),
      inputWith({ errorCode: "gps_lost_9f3a" }),
      inputWith({ episodeState: statusMarker }),
    ];

    for (const invalidInput of invalidInputs) {
      const invalidReport = expectFixedInvalidReport(buildAlarmReport(invalidInput));
      const json = JSON.stringify(invalidReport);
      expect(json).toBe(
        '{"schemaVersion":1,"valid":false,"reportError":"INVALID_ALARM_REPORT"}',
      );
      expect(json).not.toContain(statusMarker);
      expect(json).not.toContain(overlongId);
      expect(json).not.toContain("taxi 4711");
      expect(json).not.toContain("gps_lost");
    }
  });
});

