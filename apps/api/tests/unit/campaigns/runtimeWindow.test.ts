import { afterEach, describe, expect, it, vi } from "vitest";
import {
  validateCampaignRuntime,
  type CampaignRuntimeError,
  type CampaignRuntimeErrorCode,
  type CampaignRuntimeField,
  type CampaignRuntimeResult,
} from "../../../src/modules/campaigns/runtimeWindow.js";

const VALID_START = "2026-03-01T10:00:00.000Z";
const VALID_END = "2026-03-01T12:30:00.000Z";

function successValue(startAt: unknown, endAt: unknown): { startAt: string; endAt: string } {
  const result = validateCampaignRuntime(startAt, endAt);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("Erwartet wurde ein gültiges Laufzeitfenster.");
  }
  return result.value;
}

function errorsOf(startAt: unknown, endAt: unknown): CampaignRuntimeError[] {
  const result: CampaignRuntimeResult = validateCampaignRuntime(startAt, endAt);
  expect(result.ok).toBe(false);
  if (result.ok) {
    return [];
  }
  return result.errors;
}

function expectSingleError(
  startAt: unknown,
  endAt: unknown,
  field: CampaignRuntimeField,
  code: CampaignRuntimeErrorCode,
): CampaignRuntimeError {
  const errors = errorsOf(startAt, endAt);
  expect(errors).toHaveLength(1);
  const error = errors[0];
  expect(error.field).toBe(field);
  expect(error.code).toBe(code);
  expect(error.message).toMatch(/[A-Za-zÄÖÜäöüß]/);
  expect(error.message.length).toBeGreaterThan(10);
  return error;
}

describe("CX-004 Laufzeitvalidierung: Annahme gültiger Fenster", () => {
  it("akzeptiert ein synthetisches Fenster mit UTC-Zeitpunkten und Ende nach Start", () => {
    const value = successValue(VALID_START, VALID_END);
    expect(value).toEqual({ startAt: VALID_START, endAt: VALID_END });
  });

  it("gibt beide Eingaben unverändert zurück", () => {
    const startAt = "2026-03-01T10:00:00.000Z";
    const endAt = "2026-03-01T12:30:00.000Z";
    const value = successValue(startAt, endAt);
    expect(value.startAt).toBe(startAt);
    expect(value.endAt).toBe(endAt);
    expect(value.startAt).toHaveLength(24);
    expect(value.endAt).toHaveLength(24);
  });

  it("liefert genau die Felder startAt und endAt ohne Zusatzdaten", () => {
    const value = successValue(VALID_START, VALID_END);
    expect(Object.keys(value).sort()).toEqual(["endAt", "startAt"]);
  });

  it("verändert die übergebenen Strings nicht und wirft keine Exception", () => {
    const startAt = VALID_START;
    const endAt = VALID_END;
    const before = [startAt, endAt];
    expect(() => validateCampaignRuntime(startAt, endAt)).not.toThrow();
    expect([startAt, endAt]).toEqual(before);
  });
});

describe("CX-004 Laufzeitvalidierung: Intervall", () => {
  it("lehnt gleiche Zeitpunkte mit invalid_interval und deutscher Meldung ab", () => {
    const error = expectSingleError(VALID_START, VALID_START, "interval", "invalid_interval");
    expect(error.message).toContain("strikt nach");
  });

  it("lehnt ein Ende vor dem Start mit invalid_interval ab", () => {
    const error = expectSingleError(VALID_END, VALID_START, "interval", "invalid_interval");
    expect(error.message).toContain("Endzeitpunkt");
    expect(error.message).toContain("Startzeitpunkt");
  });

  it("lehnt ein Ende eine Millisekunde vor dem Start ab", () => {
    expectSingleError(
      "2026-03-01T10:00:00.001Z",
      "2026-03-01T10:00:00.000Z",
      "interval",
      "invalid_interval",
    );
  });

  it("gibt in der Intervallmeldung keine Eingabewerte wieder", () => {
    const error = expectSingleError(
      "2026-03-02T10:00:00.000Z",
      "2026-03-01T10:00:00.000Z",
      "interval",
      "invalid_interval",
    );
    expect(error.message).not.toContain("2026");
    expect(error.message).not.toContain("T10");
  });
});

describe("CX-004 Laufzeitvalidierung: fehlende und typfremde Werte", () => {
  const invalidValues: ReadonlyArray<{ name: string; value: unknown }> = [
    { name: "undefined", value: undefined },
    { name: "null", value: null },
    { name: "Zahl 42", value: 42 },
    { name: "Zahl 0", value: 0 },
    { name: "negative Zahl", value: -1 },
    { name: "NaN", value: Number.NaN },
    { name: "Infinity", value: Number.POSITIVE_INFINITY },
    { name: "leerer String", value: "" },
    { name: "String aus Leerzeichen", value: "   " },
    { name: "Boolean true", value: true },
    { name: "Boolean false", value: false },
    { name: "leeres Objekt", value: {} },
    { name: "leeres Array", value: [] },
    { name: "Array mit Zeitpunkt", value: [VALID_START] },
    { name: "ungültiger Datumsstring", value: "kein-datum" },
  ];

  for (const invalid of invalidValues) {
    it("lehnt " + invalid.name + " als startAt ohne Exception mit Feldbezug ab", () => {
      expect(() => validateCampaignRuntime(invalid.value, VALID_END)).not.toThrow();
      expectSingleError(invalid.value, VALID_END, "startAt", "invalid_timestamp");
    });

    it("lehnt " + invalid.name + " als endAt ohne Exception mit Feldbezug ab", () => {
      expect(() => validateCampaignRuntime(VALID_START, invalid.value)).not.toThrow();
      expectSingleError(VALID_START, invalid.value, "endAt", "invalid_timestamp");
    });
  }

  it("meldet bei zwei fehlenden Werten zuerst startAt und dann endAt", () => {
    const errors = errorsOf(undefined, undefined);
    expect(errors).toHaveLength(2);
    expect(errors.map((error) => error.field)).toEqual(["startAt", "endAt"]);
    expect(errors.map((error) => error.code)).toEqual([
      "invalid_timestamp",
      "invalid_timestamp",
    ]);
  });

  it("meldet bei zwei ungültigen Zeitpunkten keinen zusätzlichen Intervallfehler", () => {
    const errors = errorsOf("2026-02-30T10:00:00.000Z", "2026-02-30T09:00:00.000Z");
    expect(errors).toHaveLength(2);
    expect(errors.map((error) => error.field)).toEqual(["startAt", "endAt"]);
    expect(errors.some((error) => error.code === "invalid_interval")).toBe(false);
  });

  it("meldet bei einem ungültigen Zeitpunkt keinen Intervallfehler, auch wenn das Ende davor liegt", () => {
    const errors = errorsOf(VALID_END, "ungültig");
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("endAt");
    expect(errors[0].code).toBe("invalid_timestamp");
  });

  it("gibt ungültige Eingabewerte nicht in der Meldung wieder", () => {
    const error = expectSingleError(
      "GEHEIM-123",
      VALID_END,
      "startAt",
      "invalid_timestamp",
    );
    expect(error.message).not.toContain("GEHEIM");
    expect(error.message).toContain("Startzeitpunkt");
  });
});

describe("CX-004 Laufzeitvalidierung: Kalendergültigkeit", () => {
  const invalidDates: ReadonlyArray<{ name: string; startAt: string }> = [
    { name: "30. Februar 2026", startAt: "2026-02-30T10:00:00.000Z" },
    { name: "29. Februar 2026 (kein Schaltjahr)", startAt: "2026-02-29T10:00:00.000Z" },
    { name: "29. Februar 1900 (kein Schaltjahr)", startAt: "1900-02-29T10:00:00.000Z" },
    { name: "31. April", startAt: "2026-04-31T10:00:00.000Z" },
    { name: "Monat 00", startAt: "2026-00-10T10:00:00.000Z" },
    { name: "Monat 13", startAt: "2026-13-10T10:00:00.000Z" },
    { name: "Tag 00", startAt: "2026-03-00T10:00:00.000Z" },
    { name: "Stunde 24", startAt: "2026-03-01T24:00:00.000Z" },
    { name: "Minute 60", startAt: "2026-03-01T10:60:00.000Z" },
    { name: "Sekunde 60", startAt: "2026-03-01T10:00:60.000Z" },
    { name: "Jahr 0000", startAt: "0000-01-01T00:00:00.000Z" },
  ];

  for (const invalid of invalidDates) {
    it("lehnt " + invalid.name + " ab", () => {
      expectSingleError(invalid.startAt, VALID_END, "startAt", "invalid_timestamp");
    });
  }

  it("normalisiert die Stunde 24 nicht stillschweigend auf den Folgetag", () => {
    expectSingleError("2026-03-01T24:00:00.000Z", VALID_END, "startAt", "invalid_timestamp");
  });

  it("akzeptiert den gültigen Schalttag 29. Februar 2024", () => {
    expect(successValue("2024-02-29T00:00:00.000Z", "2024-03-01T00:00:00.000Z")).toEqual({
      startAt: "2024-02-29T00:00:00.000Z",
      endAt: "2024-03-01T00:00:00.000Z",
    });
  });

  it("akzeptiert den gültigen Schalttag 29. Februar 2000 (durch 400 teilbar)", () => {
    expect(successValue("2000-02-29T10:00:00.000Z", "2000-02-29T11:00:00.000Z")).toEqual({
      startAt: "2000-02-29T10:00:00.000Z",
      endAt: "2000-02-29T11:00:00.000Z",
    });
  });

  it("akzeptiert den 31. Januar und den 31. Dezember", () => {
    expect(successValue("2026-01-31T00:00:00.000Z", "2026-01-31T01:00:00.000Z")).toEqual({
      startAt: "2026-01-31T00:00:00.000Z",
      endAt: "2026-01-31T01:00:00.000Z",
    });
    expect(successValue("2026-12-31T00:00:00.000Z", "2026-12-31T01:00:00.000Z")).toEqual({
      startAt: "2026-12-31T00:00:00.000Z",
      endAt: "2026-12-31T01:00:00.000Z",
    });
  });

  it("akzeptiert die Jahresgrenzen 0001 und 9999", () => {
    expect(successValue("0001-01-01T00:00:00.000Z", "0001-01-01T00:00:00.001Z")).toEqual({
      startAt: "0001-01-01T00:00:00.000Z",
      endAt: "0001-01-01T00:00:00.001Z",
    });
    expect(successValue("9999-12-31T23:59:59.000Z", "9999-12-31T23:59:59.999Z")).toEqual({
      startAt: "9999-12-31T23:59:59.000Z",
      endAt: "9999-12-31T23:59:59.999Z",
    });
  });
});

describe("CX-004 Laufzeitvalidierung: Format ohne Normalisierung", () => {
  const invalidFormats: ReadonlyArray<{ name: string; startAt: string }> = [
    { name: "ohne Millisekunden", startAt: "2026-03-01T10:00:00Z" },
    { name: "mit numerischem Offset +00:00", startAt: "2026-03-01T10:00:00.000+00:00" },
    { name: "mit numerischem Offset +01:00", startAt: "2026-03-01T10:00:00.000+01:00" },
    { name: "mit numerischem Offset -05:00", startAt: "2026-03-01T10:00:00.000-05:00" },
    { name: "ohne Zeitzone", startAt: "2026-03-01T10:00:00.000" },
    { name: "mit Leerzeichen statt T", startAt: "2026-03-01 10:00:00.000Z" },
    { name: "mit kleinem z", startAt: "2026-03-01T10:00:00.000z" },
    { name: "mit einstelligem Monat", startAt: "2026-3-01T10:00:00.000Z" },
    { name: "mit einstelligem Tag", startAt: "2026-03-1T10:00:00.000Z" },
    { name: "mit führendem Leerzeichen", startAt: " 2026-03-01T10:00:00.000Z" },
    { name: "mit abschließendem Leerzeichen", startAt: "2026-03-01T10:00:00.000Z " },
    { name: "mit Zeilenumbruch", startAt: "2026-03-01T10:00:00.000Z\n" },
    { name: "mit nur einer Millisekundenstelle", startAt: "2026-03-01T10:00:00.0Z" },
    { name: "mit vier Millisekundenstellen", startAt: "2026-03-01T10:00:00.0000Z" },
    { name: "als reines Datum", startAt: "2026-03-01" },
  ];

  for (const invalid of invalidFormats) {
    it("lehnt " + invalid.name + " ab", () => {
      expectSingleError(invalid.startAt, VALID_END, "startAt", "invalid_timestamp");
    });
  }

  it("lehnt fehlende Millisekunden auch am Ende ab", () => {
    expectSingleError(VALID_START, "2026-03-01T12:30:00Z", "endAt", "invalid_timestamp");
  });

  it("lehnt einen numerischen Offset am Ende ab", () => {
    expectSingleError(
      VALID_START,
      "2026-03-01T12:30:00.000+01:00",
      "endAt",
      "invalid_timestamp",
    );
  });

  it("verlangt die Zeitzone Z ausdrücklich", () => {
    const error = expectSingleError(
      "2026-03-01T10:00:00.000+00:00",
      VALID_END,
      "startAt",
      "invalid_timestamp",
    );
    expect(error.message).toContain("YYYY-MM-DDTHH:mm:ss.SSSZ");
  });
});

describe("CX-004 Laufzeitvalidierung: Unabhängigkeit von Systemzeit und Zeitzone", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("akzeptiert ein vollständig vergangenes Fenster", () => {
    expect(successValue("1999-12-31T22:00:00.000Z", "1999-12-31T23:00:00.000Z")).toEqual({
      startAt: "1999-12-31T22:00:00.000Z",
      endAt: "1999-12-31T23:00:00.000Z",
    });
  });

  it("akzeptiert ein vollständig zukünftiges Fenster", () => {
    expect(successValue("2999-01-01T00:00:00.000Z", "2999-01-01T00:00:01.000Z")).toEqual({
      startAt: "2999-01-01T00:00:00.000Z",
      endAt: "2999-01-01T00:00:01.000Z",
    });
  });

  it("liefert unabhängig von Date.now dasselbe Ergebnis", () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(0);
    const atEpoch = validateCampaignRuntime(VALID_START, VALID_END);

    nowSpy.mockReturnValue(Date.UTC(2050, 0, 1, 0, 0, 0, 0));
    const inFuture = validateCampaignRuntime(VALID_START, VALID_END);

    nowSpy.mockReturnValue(Date.UTC(1990, 0, 1, 0, 0, 0, 0));
    const inPast = validateCampaignRuntime(VALID_START, VALID_END);

    expect(inFuture).toEqual(atEpoch);
    expect(inPast).toEqual(atEpoch);
    expect(nowSpy).not.toHaveBeenCalled();
  });

  it("liefert unter verschiedenen lokalen Zeitzonen dasselbe Ergebnis", () => {
    const originalTimeZone = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati";
      const first = validateCampaignRuntime(VALID_START, VALID_END);

      process.env.TZ = "America/Anchorage";
      const second = validateCampaignRuntime(VALID_START, VALID_END);

      process.env.TZ = "UTC";
      const third = validateCampaignRuntime(VALID_START, VALID_END);

      expect(second).toEqual(first);
      expect(third).toEqual(first);
    } finally {
      if (originalTimeZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTimeZone;
      }
    }
  });

  it("liefert ein synchrones Ergebnis und keine Promise", () => {
    const result = validateCampaignRuntime(VALID_START, VALID_END);
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as { then?: unknown }).then).toBe("undefined");
  });
});

describe("CX-004 Laufzeitvalidierung: Dauer ohne unbelegte Grenzen", () => {
  it("akzeptiert ein Fenster von genau einer Millisekunde", () => {
    expect(
      successValue("2026-05-05T00:00:00.000Z", "2026-05-05T00:00:00.001Z"),
    ).toEqual({
      startAt: "2026-05-05T00:00:00.000Z",
      endAt: "2026-05-05T00:00:00.001Z",
    });
  });

  it("akzeptiert ein jahresübergreifendes Fenster", () => {
    expect(
      successValue("2026-12-31T23:00:00.000Z", "2027-01-01T01:00:00.000Z"),
    ).toEqual({
      startAt: "2026-12-31T23:00:00.000Z",
      endAt: "2027-01-01T01:00:00.000Z",
    });
  });

  it("akzeptiert ein jahresübergreifendes Fenster von einer Millisekunde", () => {
    expect(
      successValue("2026-12-31T23:59:59.999Z", "2027-01-01T00:00:00.000Z"),
    ).toEqual({
      startAt: "2026-12-31T23:59:59.999Z",
      endAt: "2027-01-01T00:00:00.000Z",
    });
  });

  it("führt keine maximale Dauer ein und akzeptiert ein Fenster über die gesamte Jahrespanne", () => {
    expect(
      successValue("0001-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z"),
    ).toEqual({
      startAt: "0001-01-01T00:00:00.000Z",
      endAt: "9999-12-31T23:59:59.999Z",
    });
  });

  it("verlangt keine Mindestdauer über eine Millisekunde hinaus", () => {
    const result = validateCampaignRuntime(
      "2026-05-05T00:00:00.000Z",
      "2026-05-05T00:00:00.001Z",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.startAt).not.toBe(result.value.endAt);
    }
  });
});
