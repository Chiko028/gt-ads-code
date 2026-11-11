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

interface Bucket {
  windowStartMs: number;
  count: number;
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
      const fresh: Bucket = { windowStartMs: nowMs, count: 0 };
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

  /** Liest den Zustand, ohne zu zaehlen. */
  peek(key = "global"): RateLimitResult {
    const nowMs = this.now();
    const bucket = this.currentBucket(key, nowMs);
    const windowEndMs = bucket.windowStartMs + this.windowMs;
    const remaining = Math.max(0, this.max - bucket.count);
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
