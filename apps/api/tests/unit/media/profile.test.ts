import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MEDIA_MAX_SIZE_BYTES,
  validateMediaProfile,
  type MediaProfileError,
  type MediaProfileErrorCode,
  type MediaProfileInput,
  type MediaProfileResult,
} from "../../../src/modules/media/profile.js";

const REQUIRED_FIELDS: ReadonlyArray<keyof MediaProfileInput> = [
  "container",
  "videoCodec",
  "width",
  "height",
  "frameRateNumerator",
  "frameRateDenominator",
  "audioStreamCount",
  "durationSeconds",
  "sizeBytes",
];

function validInput(overrides: Partial<MediaProfileInput> = {}): MediaProfileInput {
  return {
    container: "mp4",
    videoCodec: "h264",
    width: 1920,
    height: 1080,
    frameRateNumerator: 30,
    frameRateDenominator: 1,
    audioStreamCount: 0,
    durationSeconds: 15,
    sizeBytes: 12_000_000,
    ...overrides,
  };
}

function errorsOf(input: unknown): MediaProfileError[] {
  const result = validateMediaProfile(input);
  expect(result.valid).toBe(false);
  if (result.valid) {
    return [];
  }
  return result.errors;
}

function codesOf(input: unknown): MediaProfileErrorCode[] {
  return errorsOf(input).map((error) => error.code);
}

describe("CX-003 Medienprofilprüfung: Annahme", () => {
  it("akzeptiert einen synthetischen 15-Sekunden-Spot (MP4, H.264, 1920x1080, 30/1 fps, ohne Ton, unter 1.000 MB)", () => {
    const input = validInput();
    const result = validateMediaProfile(input);
    expect(result).toEqual({ valid: true });
  });

  it("akzeptiert zusätzliche, nicht benötigte Metadaten ohne sie weiterzureichen", () => {
    const result = validateMediaProfile({
      ...validInput(),
      filename: "synthetischer-spot.mp4",
      bitrate: 8_000_000,
    });
    expect(result).toEqual({ valid: true });
    expect(result).not.toHaveProperty("filename");
    expect(result).not.toHaveProperty("bitrate");
  });
});

describe("CX-003 Medienprofilprüfung: einzelne Profilverstöße", () => {
  const violations: ReadonlyArray<{
    name: string;
    patch: Partial<MediaProfileInput>;
    code: MediaProfileErrorCode;
    fieldPart: string;
    messagePart: string;
  }> = [
    {
      name: "einen falschen Container",
      patch: { container: "mov" },
      code: "unsupported_container",
      fieldPart: "container",
      messagePart: "MP4",
    },
    {
      name: "einen anderen Videocodec",
      patch: { videoCodec: "hevc" },
      code: "unsupported_video_codec",
      fieldPart: "videoCodec",
      messagePart: "H.264",
    },
    {
      name: "eine zu kleine Auflösung",
      patch: { width: 1280, height: 720 },
      code: "unsupported_resolution",
      fieldPart: "width",
      messagePart: "1920×1080",
    },
    {
      name: "eine abweichende Höhe",
      patch: { height: 1081 },
      code: "unsupported_resolution",
      fieldPart: "height",
      messagePart: "1920×1080",
    },
    {
      name: "eine abweichende Bildrate (25/1)",
      patch: { frameRateNumerator: 25 },
      code: "unsupported_frame_rate",
      fieldPart: "frameRateNumerator",
      messagePart: "30 fps",
    },
    {
      name: "eine abweichende Bildrate (30/2)",
      patch: { frameRateDenominator: 2 },
      code: "unsupported_frame_rate",
      fieldPart: "frameRateDenominator",
      messagePart: "30 fps",
    },
    {
      name: "eine vorhandene Audiospur",
      patch: { audioStreamCount: 1 },
      code: "audio_not_allowed",
      fieldPart: "audioStreamCount",
      messagePart: "Audiospur",
    },
    {
      name: "zwei Audiospuren",
      patch: { audioStreamCount: 2 },
      code: "audio_not_allowed",
      fieldPart: "audioStreamCount",
      messagePart: "Audiospur",
    },
  ];

  for (const violation of violations) {
    it("lehnt " + violation.name + " mit " + violation.code + " und deutscher Meldung ab", () => {
      const errors = errorsOf(validInput(violation.patch));
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe(violation.code);
      expect(errors[0].field).toContain(violation.fieldPart);
      expect(errors[0].message).toContain(violation.messagePart);
      expect(errors[0].message).toMatch(/[A-Za-zÄÖÜäöüß]/);
    });
  }

  it("vergibt für Container, Codec, Auflösung, Bildrate und Audio unterscheidbare Fehlercodes", () => {
    const cases: MediaProfileInput[] = [
      validInput({ container: "mov" }),
      validInput({ videoCodec: "hevc" }),
      validInput({ width: 1280 }),
      validInput({ frameRateNumerator: 25 }),
      validInput({ audioStreamCount: 1 }),
    ];
    const codes = cases.map((input) => {
      const errors = errorsOf(input);
      expect(errors).toHaveLength(1);
      return errors[0].code;
    });
    expect(new Set(codes).size).toBe(5);
  });

  it("sammelt alle Profilverletzungen in fester Reihenfolge", () => {
    const result = validateMediaProfile({
      container: "mov",
      videoCodec: "hevc",
      width: 1280,
      height: 720,
      frameRateNumerator: 25,
      frameRateDenominator: 1,
      audioStreamCount: 1,
      durationSeconds: 15,
      sizeBytes: 1_000_000_001,
    });
    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.errors.map((error) => error.code)).toEqual([
      "unsupported_container",
      "unsupported_video_codec",
      "unsupported_resolution",
      "unsupported_frame_rate",
      "audio_not_allowed",
      "file_too_large",
    ]);
  });
});

describe("CX-003 Medienprofilprüfung: Dateigröße", () => {
  it("akzeptiert genau 1.000.000.000 Byte (L-01)", () => {
    expect(validateMediaProfile(validInput({ sizeBytes: 1_000_000_000 }))).toEqual({ valid: true });
  });

  it("akzeptiert 999.999.999 Byte und die frueheren Grenzwerte 20.000.000/20.000.001 Byte", () => {
    expect(validateMediaProfile(validInput({ sizeBytes: 999_999_999 }))).toEqual({ valid: true });
    expect(validateMediaProfile(validInput({ sizeBytes: 20_000_000 }))).toEqual({ valid: true });
    expect(validateMediaProfile(validInput({ sizeBytes: 20_000_001 }))).toEqual({ valid: true });
  });

  it("lehnt 1.000.000.001 Byte mit file_too_large ab", () => {
    const errors = errorsOf(validInput({ sizeBytes: 1_000_000_001 }));
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("file_too_large");
    expect(errors[0].field).toBe("sizeBytes");
    expect(errors[0].message).toContain("1.000 MB");
  });

  const invalidSizes: ReadonlyArray<{ name: string; value: number }> = [
    { name: "negativer Bytewert", value: -1 },
    { name: "gebrochener Bytewert", value: 1.5 },
    { name: "nicht sicherer ganzzahliger Bytewert", value: Number.MAX_SAFE_INTEGER + 2 },
    { name: "Bytewert null", value: 0 },
    { name: "NaN als Bytewert", value: Number.NaN },
    { name: "Infinity als Bytewert", value: Number.POSITIVE_INFINITY },
    { name: "-Infinity als Bytewert", value: Number.NEGATIVE_INFINITY },
  ];

  for (const invalidSize of invalidSizes) {
    it("lehnt " + invalidSize.name + " als invalid_metadata ab", () => {
      const errors = errorsOf(validInput({ sizeBytes: invalidSize.value }));
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe("invalid_metadata");
      expect(errors[0].field).toBe("sizeBytes");
      expect(errors[0].message).toMatch(/Pflichtfeld|endliche|positive/);
    });
  }
});

describe("CX-003 Medienprofilprüfung: Bildrate", () => {
  it("akzeptiert 60/2 fps wie 30/1 fps", () => {
    expect(
      validateMediaProfile(
        validInput({ frameRateNumerator: 60, frameRateDenominator: 2 }),
      ),
    ).toEqual({ valid: true });
    expect(
      validateMediaProfile(
        validInput({ frameRateNumerator: 30, frameRateDenominator: 1 }),
      ),
    ).toEqual({ valid: true });
  });

  it("akzeptiert 90/3 fps als exakte 30 fps", () => {
    expect(
      validateMediaProfile(
        validInput({ frameRateNumerator: 90, frameRateDenominator: 3 }),
      ),
    ).toEqual({ valid: true });
  });

  const invalidFrameRates: ReadonlyArray<{
    name: string;
    patch: Partial<MediaProfileInput>;
    field: string;
  }> = [
    { name: "Nenner null", patch: { frameRateDenominator: 0 }, field: "frameRateDenominator" },
    { name: "negativen Nenner", patch: { frameRateDenominator: -1 }, field: "frameRateDenominator" },
    { name: "negativen Zähler", patch: { frameRateNumerator: -30 }, field: "frameRateNumerator" },
    { name: "NaN als Zähler", patch: { frameRateNumerator: Number.NaN }, field: "frameRateNumerator" },
    { name: "Infinity als Nenner", patch: { frameRateDenominator: Number.POSITIVE_INFINITY }, field: "frameRateDenominator" },
    { name: "gebrochenen Zähler", patch: { frameRateNumerator: 30.5 }, field: "frameRateNumerator" },
  ];

  for (const invalidFrameRate of invalidFrameRates) {
    it("lehnt " + invalidFrameRate.name + " als ungültige Metadaten ab", () => {
      const input = validInput(invalidFrameRate.patch);
      expect(() => validateMediaProfile(input)).not.toThrow();
      const errors = errorsOf(input);
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe("invalid_metadata");
      expect(errors[0].field).toBe(invalidFrameRate.field);
      expect(errors[0].message).toMatch(/Pflichtfeld|endliche|positive/);
    });
  }
});

describe("CX-003 Medienprofilprüfung: fehlende oder ungültige Pflichtmetadaten", () => {
  const malformedInputs: ReadonlyArray<{ name: string; input: unknown }> = [
    { name: "null", input: null },
    { name: "undefined", input: undefined },
    { name: "ein Array", input: [] },
    { name: "ein Text", input: "mp4" },
    { name: "eine Zahl", input: 42 },
    { name: "ein leeres Objekt", input: {} },
  ];

  for (const malformed of malformedInputs) {
    it("liefert für " + malformed.name + " ein negatives Ergebnis ohne Exception", () => {
      let result: MediaProfileResult | undefined;
      expect(() => {
        result = validateMediaProfile(malformed.input);
      }).not.toThrow();
      expect(result?.valid).toBe(false);
      if (!result || result.valid) {
        return;
      }
      expect(result.errors.length).toBeGreaterThan(0);
      for (const error of result.errors) {
        expect(error.code).toBe("invalid_metadata");
        expect(error.field.length).toBeGreaterThan(0);
        expect(error.message).toMatch(/Pflichtfeld|Metadaten/);
      }
    });
  }

  for (const field of REQUIRED_FIELDS) {
    it("meldet das fehlende Pflichtfeld " + field + " als invalid_metadata", () => {
      const input: Record<string, unknown> = { ...validInput() };
      delete input[field];
      const errors = errorsOf(input);
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe("invalid_metadata");
      expect(errors[0].field).toBe(field);
      expect(errors[0].message).toContain(field);
    });
  }

  const wrongTypes: ReadonlyArray<{ name: string; field: keyof MediaProfileInput; value: unknown }> = [
    { name: "Text statt Container", field: "container", value: 42 },
    { name: "null statt Codec", field: "videoCodec", value: null },
    { name: "Text statt Breite", field: "width", value: "1920" },
    { name: "Boolean statt Höhe", field: "height", value: true },
    { name: "Text statt Bildratenzähler", field: "frameRateNumerator", value: "30" },
    { name: "Objekt statt Bildratennenner", field: "frameRateDenominator", value: {} },
    { name: "Text statt Audiospuranzahl", field: "audioStreamCount", value: "0" },
    { name: "null statt Dauer", field: "durationSeconds", value: null },
    { name: "Text statt Dateigröße", field: "sizeBytes", value: "12000000" },
  ];

  for (const wrongType of wrongTypes) {
    it("lehnt " + wrongType.name + " als invalid_metadata ab", () => {
      const input: Record<string, unknown> = { ...validInput() };
      input[wrongType.field] = wrongType.value;
      const errors = errorsOf(input);
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe("invalid_metadata");
      expect(errors[0].field).toBe(wrongType.field);
    });
  }

  it("nennt bei einem leeren Objekt alle Pflichtfelder in fester Reihenfolge", () => {
    const errors = errorsOf({});
    expect(errors.map((error) => error.field)).toEqual([...REQUIRED_FIELDS]);
    expect(errors.every((error) => error.code === "invalid_metadata")).toBe(true);
  });

  it("akzeptiert bei gültiger Struktur keine stillschweigende Annahme fehlender Werte", () => {
    const withoutSize: Record<string, unknown> = { ...validInput() };
    delete withoutSize.sizeBytes;
    expect(validateMediaProfile(withoutSize).valid).toBe(false);

    const withoutAudioCount: Record<string, unknown> = { ...validInput() };
    delete withoutAudioCount.audioStreamCount;
    expect(validateMediaProfile(withoutAudioCount).valid).toBe(false);
  });
});

describe("CX-003 Medienprofilprüfung: Dauer", () => {
  it("akzeptiert 15 Sekunden als Standardwert", () => {
    expect(validateMediaProfile(validInput({ durationSeconds: 15 }))).toEqual({ valid: true });
  });

  it("akzeptiert Dauern von 5 bis 60 Sekunden einschließlich", () => {
    for (const durationSeconds of [5, 8, 15.5, 16, 30, 60, 60.0004]) {
      expect(validateMediaProfile(validInput({ durationSeconds }))).toEqual({ valid: true });
    }
  });

  it("lehnt Dauern außerhalb von 5 bis 60 Sekunden ab", () => {
    for (const durationSeconds of [0.5, 4.99, 60.01, 120]) {
      expect(codesOf(validInput({ durationSeconds }))).toEqual(["unsupported_duration"]);
    }
  });

  const invalidDurations: ReadonlyArray<{ name: string; value: number }> = [
    { name: "Dauer null", value: 0 },
    { name: "negative Dauer", value: -15 },
    { name: "NaN als Dauer", value: Number.NaN },
    { name: "Infinity als Dauer", value: Number.POSITIVE_INFINITY },
  ];

  for (const invalidDuration of invalidDurations) {
    it("lehnt " + invalidDuration.name + " als invalid_metadata ab", () => {
      const errors = errorsOf(validInput({ durationSeconds: invalidDuration.value }));
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe("invalid_metadata");
      expect(errors[0].field).toBe("durationSeconds");
    });
  }
});

describe("CX-003 Medienprofilprüfung: Reproduzierbarkeit und Reinheit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("liefert bei wiederholter Prüfung identische Ergebnisse", () => {
    const input = Object.freeze(
      validInput({ container: "mov", audioStreamCount: 1, sizeBytes: 1_000_000_001 }),
    );
    const first = validateMediaProfile(input);
    const second = validateMediaProfile(input);
    const third = validateMediaProfile(input);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first.valid).toBe(false);
    expect(first).not.toBe(second);
  });

  it("verändert die Eingabe nicht", () => {
    const input = validInput({ audioStreamCount: 2 });
    const snapshot = JSON.stringify(input);
    const keysBefore = Object.keys(input).sort();

    validateMediaProfile(input);

    expect(JSON.stringify(input)).toBe(snapshot);
    expect(Object.keys(input).sort()).toEqual(keysBefore);
  });

  it("verändert auch eine tiefgefrorene Eingabe nicht und wirft keine Exception", () => {
    const input = Object.freeze(validInput({ frameRateNumerator: 25 }));
    expect(() => validateMediaProfile(input)).not.toThrow();
    expect(validateMediaProfile(input)).toEqual({
      valid: false,
      errors: [
        expect.objectContaining({ code: "unsupported_frame_rate" }),
      ],
    });
  });

  it("benötigt weder Netzwerk noch Datenbank oder externe Prozesse", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = validateMediaProfile(validInput());
    expect(result).toEqual({ valid: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("liefert synchron ein Ergebnis und keine Promise", () => {
    const result = validateMediaProfile(validInput());
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as { then?: unknown }).then).toBe("undefined");
  });
});

describe("CX-155 / R-202 Medienprofilgrenze", () => {
  it("exportiert die Obergrenze als 1.000.000.000 Byte", () => {
    expect(MEDIA_MAX_SIZE_BYTES).toBe(1_000_000_000);
  });

  it("akzeptiert ansonsten profilgerechte Metadaten mit 37.500.000 Byte ohne große Datei", () => {
    const result = validateMediaProfile(validInput({ sizeBytes: 37_500_000 }));
    expect(result).toEqual({ valid: true });
  });

  it("akzeptiert genau 1.000.000.000 Byte als einschließende Grenze", () => {
    expect(validateMediaProfile(validInput({ sizeBytes: 1_000_000_000 }))).toEqual({
      valid: true,
    });
  });

  it("lehnt 1.000.000.001 Byte mit file_too_large ab und nennt 1.000 MB", () => {
    const errors = errorsOf(validInput({ sizeBytes: 1_000_000_001 }));
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("file_too_large");
    expect(errors[0].field).toBe("sizeBytes");
    expect(errors[0].message).toContain("1.000 MB");
  });

  const regressions: ReadonlyArray<{
    name: string;
    patch: Partial<MediaProfileInput>;
    code: MediaProfileErrorCode;
  }> = [
    {
      name: "vorhandene Tonspur",
      patch: { audioStreamCount: 1 },
      code: "audio_not_allowed",
    },
    {
      name: "falscher Codec",
      patch: { videoCodec: "hevc" },
      code: "unsupported_video_codec",
    },
    {
      name: "falsche Auflösung",
      patch: { width: 1280, height: 720 },
      code: "unsupported_resolution",
    },
    {
      name: "falsche Bildrate",
      patch: { frameRateNumerator: 25 },
      code: "unsupported_frame_rate",
    },
  ];

  it.each(regressions)(
    "behält bei zulässiger Dateigröße die Ablehnung $name als $code",
    ({ patch, code }) => {
      const errors = errorsOf(validInput({ ...patch, sizeBytes: 37_500_000 }));
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe(code);
    },
  );
});

