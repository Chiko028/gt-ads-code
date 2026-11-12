/**
 * Einfacher In-Memory-Rate-Limiter (Fensterzähler, Einzelinstanz-Annahme
 * laut ARCHITEKTUR.md Abschnitt 4). Nicht fuer Produktion gedacht.
 */
export interface RateLimiterOptions {
  /** Maximale Treffer je Fenster. */
  max: number;
  /** Fensterlaenge in Millisekunden. */
  windowMs: number;
  /** Injizierbare Uhr fuer Tests; Standard Date.now. */
  now?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Verbleibende Treffer im aktuellen Fenster. */
  remaining: number;
  /** Sekunden bis zum Fensterende (0, wenn wieder erlaubt). */
  retryAfterSeconds: number;
  /** Ende des aktuellen Fensters als Unix-Millisekunden. */
  resetAtMs: number;
}

/** Reservierter Versuch; genau einmal commitFailure() oder release() rufen. */
export interface RateLimitTicket {
  /** Zaehlt den reservierten Versuch dauerhaft als Fehlversuch. */
  commitFailure(): void;
  /** Gibt den reservierten Platz ohne Fehlversuch wieder frei. */
  release(): void;
}

/** Ergebnis einer atomaren Reservierung. */
export type RateLimitReservation =
  | (RateLimitResult & { allowed: true; ticket: RateLimitTicket })
  | (RateLimitResult & { allowed: false; ticket: null });

interface Bucket {
  windowStartMs: number;
  count: number;
  /** Noch nicht entschiedene, aber bereits reservierte Versuche. */
  inFlight: number;
}

export class RateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: RateLimiterOptions) {
    if (!Number.isInteger(options.max) || options.max < 1) {
      throw new RangeError("max muss eine ganze Zahl >= 1 sein");
    }
    if (!Number.isInteger(options.windowMs) || options.windowMs < 1) {
      throw new RangeError("windowMs muss eine ganze Zahl >= 1 sein");
    }
    this.max = options.max;
    this.windowMs = options.windowMs;
    this.now = options.now ?? (() => Date.now());
  }

  private currentBucket(key: string, nowMs: number): Bucket {
    const existing = this.buckets.get(key);
    if (existing === undefined || nowMs >= existing.windowStartMs + this.windowMs) {
      const fresh: Bucket = { windowStartMs: nowMs, count: 0, inFlight: 0 };
      this.buckets.set(key, fresh);
      return fresh;
    }
    return existing;
  }

  private static retryAfterSeconds(windowEndMs: number, nowMs: number): number {
    const remainingMs = windowEndMs - nowMs;
    return remainingMs <= 0 ? 0 : Math.ceil(remainingMs / 1000);
  }

  /** Zaehlt einen Treffer und liefert die Entscheidung. */
  hit(key = "global"): RateLimitResult {
    const nowMs = this.now();
    const bucket = this.currentBucket(key, nowMs);
    const windowEndMs = bucket.windowStartMs + this.windowMs;

    if (bucket.count >= this.max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: RateLimiter.retryAfterSeconds(windowEndMs, nowMs),
        resetAtMs: windowEndMs,
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      remaining: this.max - bucket.count,
      retryAfterSeconds: 0,
      resetAtMs: windowEndMs,
    };
  }

  /**
   * Reserviert atomar einen Versuch. Der Platz zaehlt sofort als belegt
   * (inFlight), bis der Aufrufer commitFailure() oder release() aufruft.
   * Dadurch koennen parallele Aufrufe die Grenze nicht ueberschreiten.
   */
  reserve(key = "global"): RateLimitReservation {
    const nowMs = this.now();
    const bucket = this.currentBucket(key, nowMs);
    const windowEndMs = bucket.windowStartMs + this.windowMs;

    if (bucket.count + bucket.inFlight >= this.max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: RateLimiter.retryAfterSeconds(windowEndMs, nowMs),
        resetAtMs: windowEndMs,
        ticket: null,
      };
    }

    bucket.inFlight += 1;
    let settled = false;
    const settle = (counted: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      bucket.inFlight = Math.max(0, bucket.inFlight - 1);
      if (counted) {
        bucket.count += 1;
      }
    };

    return {
      allowed: true,
      remaining: Math.max(0, this.max - bucket.count - bucket.inFlight),
      retryAfterSeconds: 0,
      resetAtMs: windowEndMs,
      ticket: {
        commitFailure: () => settle(true),
        release: () => settle(false),
      },
    };
  }

  /** Liest den Zustand, ohne zu zaehlen. */
  peek(key = "global"): RateLimitResult {
    const nowMs = this.now();
    const bucket = this.currentBucket(key, nowMs);
    const windowEndMs = bucket.windowStartMs + this.windowMs;
    const remaining = Math.max(0, this.max - bucket.count - bucket.inFlight);
    return {
      allowed: remaining > 0,
      remaining,
      retryAfterSeconds: remaining > 0 ? 0 : RateLimiter.retryAfterSeconds(windowEndMs, nowMs),
      resetAtMs: windowEndMs,
    };
  }

  /** Entfernt einen oder alle Zaehler (z. B. nach erfolgreicher Anmeldung). */
  reset(key?: string): void {
    if (key === undefined) {
      this.buckets.clear();
    } else {
      this.buckets.delete(key);
    }
  }
}

/**
 * Begrenzung von Registrierungsfehlversuchen je Quelle und global
 * (SPEZIFIKATION.md Abschnitt 7, ARCHITEKTUR.md Abschnitt 4).
 *
 * Ein Versuch wird mit begin() atomar reserviert. Der reservierte Platz
 * zaehlt sofort mit, bis der Versuch als Fehlversuch bestaetigt oder wieder
 * freigegeben wird. Dadurch koennen parallele Anfragen die Grenze nicht
 * umgehen, und erfolgreiche Anfragen verbrauchen kein Kontingent.
 */
export interface RegistrationRateLimitOptions {
  perSourceMax: number;
  perSourceWindowMs: number;
  globalMax: number;
  globalWindowMs: number;
  now?: () => number;
}

const GLOBAL_KEY = "global";

export class RegistrationRateLimiter {
  readonly perSource: RateLimiter;
  readonly global: RateLimiter;

  constructor(options: RegistrationRateLimitOptions) {
    this.perSource = new RateLimiter({
      max: options.perSourceMax,
      windowMs: options.perSourceWindowMs,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.global = new RateLimiter({
      max: options.globalMax,
      windowMs: options.globalWindowMs,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  /**
   * Reserviert atomar einen Versuch bei Quelle und global. Ist eine Grenze
   * erreicht, wird die laengste verbleibende Wartezeit als Retry-After
   * geliefert; eine bereits erfolgte Quellenreservierung wird dann wieder
   * freigegeben.
   */
  begin(sourceKey: string): RateLimitReservation {
    const source = this.perSource.reserve(sourceKey);
    if (!source.allowed) {
      return source;
    }
    const global = this.global.reserve(GLOBAL_KEY);
    if (!global.allowed) {
      source.ticket.release();
      return global;
    }

    const sourceTicket = source.ticket;
    const globalTicket = global.ticket;
    let settled = false;
    return {
      allowed: true,
      remaining: Math.min(source.remaining, global.remaining),
      retryAfterSeconds: 0,
      resetAtMs: Math.max(source.resetAtMs, global.resetAtMs),
      ticket: {
        commitFailure: () => {
          if (settled) {
            return;
          }
          settled = true;
          sourceTicket.commitFailure();
          globalTicket.commitFailure();
        },
        release: () => {
          if (settled) {
            return;
          }
          settled = true;
          sourceTicket.release();
          globalTicket.release();
        },
      },
    };
  }

  /** Nur fuer Tests: alle Zaehler verwerfen. */
  reset(): void {
    this.perSource.reset();
    this.global.reset();
  }
}

/** Baut den Limiter aus den validierten Konfigurationswerten. */
export function createRegistrationRateLimiter(config: {
  registrationMaxFailsPerSource: number;
  registrationMaxFailsWindowSeconds: number;
  registrationMaxFailsGlobalPerHour: number;
}): RegistrationRateLimiter {
  return new RegistrationRateLimiter({
    perSourceMax: config.registrationMaxFailsPerSource,
    perSourceWindowMs: config.registrationMaxFailsWindowSeconds * 1000,
    globalMax: config.registrationMaxFailsGlobalPerHour,
    globalWindowMs: 3600 * 1000,
  });
}
