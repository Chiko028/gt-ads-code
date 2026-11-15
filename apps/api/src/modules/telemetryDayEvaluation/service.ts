import type { EvaluationPolicy } from "../telemetryEvaluation/types.js";
import { validatePolicy } from "../telemetryEvaluation/policy.js";
import {
  assertIanaTimeZone,
  formatLocalDate,
  parseLocalDate,
  zonedDayRange,
} from "../telemetryEvaluation/timeZone.js";
import { normalizeDeviceId } from "../telemetry/validation.js";
import { createTelemetryRollupService } from "../telemetryRollups/service.js";
import type { TelemetryRollupService } from "../telemetryRollups/service.js";
import {
  DayEvaluationConfigError,
  DayEvaluationInputError,
  DayNotCompletedError,
} from "./errors.js";
import type {
  DayEvaluationInput,
  DayEvaluationResult,
  DayEvaluationServiceOptions,
} from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * CX-047 / R-402: begrenzter, explizit ausgeloester Tagesauswertungseinstieg.
 *
 * Ein Aufruf bearbeitet genau einen bereits abgeschlossenen Kalendertag eines
 * Geraets. Die Rohdaten, Tagesgrenzen und der Zustandskontext vor Tagesbeginn
 * kommen aus den vorhandenen CX-009/CX-011-Schnittstellen; klassifiziert wird
 * unveraendert durch CX-010, geschrieben ausschliesslich ueber das
 * korrigierbare, transaktionssichere Rollup-Verfahren aus CX-011. Es gibt
 * keinen Scheduler, keine Flotten-/Zeitraumschleife und keine Retention.
 */
export class TelemetryDayEvaluationService {
  private readonly rollups: TelemetryRollupService;
  private readonly now: () => Date;

  constructor(options: DayEvaluationServiceOptions) {
    if (!isPlainObject(options)) {
      throw new DayEvaluationInputError(
        "Optionen des Tagesauswertungsdienstes fehlen.",
      );
    }
    if (typeof options.now !== "function") {
      throw new DayEvaluationInputError("now muss eine injizierte Uhr sein.");
    }
    this.rollups = createTelemetryRollupService({ client: options.client });
    this.now = options.now;
  }

  async evaluateDay(input: DayEvaluationInput): Promise<DayEvaluationResult> {
    const raw: unknown = input;
    if (!isPlainObject(raw)) {
      throw new DayEvaluationInputError(
        "Eingabe der Tagesauswertung muss ein Objekt sein.",
      );
    }

    let deviceId: string;
    try {
      deviceId = normalizeDeviceId(raw.deviceId);
    } catch (error) {
      throw new DayEvaluationInputError(
        "deviceId ist keine gueltige Geraete-ID.",
        { cause: error },
      );
    }

    const configuration = raw.configuration;
    if (!isPlainObject(configuration)) {
      throw new DayEvaluationConfigError(
        "configuration mit timeZone und policy ist verpflichtend.",
      );
    }

    const timeZone = this.requireTimeZone(configuration);
    const policy = this.requirePolicy(configuration);

    let dateParts;
    try {
      dateParts = parseLocalDate(raw.localDate);
    } catch (error) {
      throw new DayEvaluationInputError(
        "localDate ist kein gueltiges Kalenderdatum YYYY-MM-DD.",
        { cause: error },
      );
    }
    const localDate = formatLocalDate(dateParts);

    const nowMs = this.readClock();
    const { endMs } = zonedDayRange(dateParts, timeZone);
    if (nowMs < endMs) {
      throw new DayNotCompletedError(
        localDate,
        timeZone,
        new Date(endMs).toISOString(),
      );
    }

    // Erst nach erfolgreichem Commit von CX-011 entsteht ein Ergebnis.
    const { outcome, rollup } = await this.rollups.rebuildDay({
      deviceId,
      localDate,
      timeZone,
      policy,
      evaluationTime: new Date(nowMs).toISOString(),
    });

    return {
      deviceId,
      localDate,
      timeZone,
      policyVersion: rollup.policyVersion,
      algorithmVersion: rollup.algorithmVersion,
      status: outcome,
      revision: rollup.revision,
      evaluationTime: rollup.evaluationTime,
      rollup,
    };
  }

  private requireTimeZone(configuration: Record<string, unknown>): string {
    try {
      return assertIanaTimeZone(configuration.timeZone);
    } catch (error) {
      throw new DayEvaluationConfigError(
        "configuration.timeZone ist eine verpflichtende IANA-Zeitzone.",
        { cause: error },
      );
    }
  }

  private requirePolicy(
    configuration: Record<string, unknown>,
  ): EvaluationPolicy {
    try {
      return validatePolicy(configuration.policy);
    } catch (error) {
      throw new DayEvaluationConfigError(
        "configuration.policy ist unvollstaendig oder ungueltig; " +
          "E36 und E40 sind Pflicht und haben keine Defaults.",
        { cause: error },
      );
    }
  }

  private readClock(): number {
    let value: unknown;
    try {
      value = this.now();
    } catch (error) {
      throw new DayEvaluationInputError(
        "Die injizierte Uhr konnte nicht gelesen werden.",
        { cause: error },
      );
    }
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new DayEvaluationInputError(
        "Die injizierte Uhr muss ein gueltiges Date liefern.",
      );
    }
    return value.getTime();
  }
}

export function createTelemetryDayEvaluationService(
  options: DayEvaluationServiceOptions,
): TelemetryDayEvaluationService {
  return new TelemetryDayEvaluationService(options);
}
