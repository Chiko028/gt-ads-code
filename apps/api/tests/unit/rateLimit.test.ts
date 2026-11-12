import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../src/http/rateLimit.js";

describe("U-09 Rate-Limiter", () => {
  it("zaehlt im Fenster und liefert Retry-After", () => {
    let now = 1_700_000_000_000;
    const limiter = new RateLimiter({ max: 5, windowMs: 900_000, now: () => now });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = limiter.hit("192.0.2.1");
      expect(result.allowed, "Versuch " + attempt).toBe(true);
      expect(result.remaining).toBe(5 - attempt);
      expect(result.retryAfterSeconds).toBe(0);
    }

    const blocked = limiter.hit("192.0.2.1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBe(900);

    now += 400_000;
    const later = limiter.hit("192.0.2.1");
    expect(later.allowed).toBe(false);
    expect(later.retryAfterSeconds).toBe(500);

    now += 500_000;
    const nextWindow = limiter.hit("192.0.2.1");
    expect(nextWindow.allowed).toBe(true);
    expect(nextWindow.remaining).toBe(4);
  });

  it("trennt Zaehler je Quelle", () => {
    let now = 0;
    const limiter = new RateLimiter({ max: 2, windowMs: 60_000, now: () => now });
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(false);
    expect(limiter.hit("b").allowed).toBe(true);

    const peeked = limiter.peek("a");
    expect(peeked.allowed).toBe(false);
    expect(peeked.remaining).toBe(0);
  });

  it("gibt nach Ablauf des Fensters wieder frei", () => {
    let now = 0;
    const limiter = new RateLimiter({ max: 1, windowMs: 1000, now: () => now });
    expect(limiter.hit().allowed).toBe(true);
    now = 999;
    expect(limiter.hit().allowed).toBe(false);
    now = 1000;
    expect(limiter.hit().allowed).toBe(true);
  });

  it("kann Zaehler zuruecksetzen", () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 60_000, now: () => 0 });
    expect(limiter.hit("quota").allowed).toBe(true);
    expect(limiter.hit("quota").allowed).toBe(false);
    limiter.reset("quota");
    expect(limiter.hit("quota").allowed).toBe(true);
    expect(limiter.hit("other").allowed).toBe(true);
    limiter.reset();
    expect(limiter.hit("other").allowed).toBe(true);
  });

  it("validiert Konstruktorargumente", () => {
    expect(() => new RateLimiter({ max: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => new RateLimiter({ max: 1, windowMs: 0 })).toThrow(RangeError);
    expect(() => new RateLimiter({ max: 1.5, windowMs: 1000 })).toThrow(RangeError);
  });

  it("reserviert Versuche atomar bis zur Grenze", () => {
    const limiter = new RateLimiter({ max: 2, windowMs: 60_000, now: () => 0 });
    const first = limiter.reserve("source");
    const second = limiter.reserve("source");
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);

    const blocked = limiter.reserve("source");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(60);

    if (!first.allowed) {
      throw new Error("Reservierung erwartet");
    }
    first.ticket.release();
    // Mehrfaches Freigeben darf das Kontingent nicht erhoehen.
    first.ticket.release();

    const afterRelease = limiter.reserve("source");
    expect(afterRelease.allowed).toBe(true);
    if (!afterRelease.allowed) {
      throw new Error("Reservierung erwartet");
    }
    afterRelease.ticket.release();
  });

  it("bestaetigte Fehlversuche bleiben nach Reservierung gezaehlt", () => {
    const limiter = new RateLimiter({ max: 2, windowMs: 60_000, now: () => 0 });
    const first = limiter.reserve("source");
    if (!first.allowed) {
      throw new Error("Reservierung erwartet");
    }
    first.ticket.commitFailure();

    const second = limiter.reserve("source");
    expect(second.allowed).toBe(true);
    if (!second.allowed) {
      throw new Error("Reservierung erwartet");
    }
    second.ticket.release();

    const third = limiter.reserve("source");
    expect(third.allowed).toBe(true);
    if (!third.allowed) {
      throw new Error("Reservierung erwartet");
    }
    third.ticket.commitFailure();

    expect(limiter.reserve("source").allowed).toBe(false);
    expect(limiter.peek("source").remaining).toBe(0);
  });

  it("behaelt laufende Reservierungen ueber den Fensterwechsel", () => {
    let now = 0;
    const limiter = new RateLimiter({ max: 3, windowMs: 1000, now: () => now });
    const tickets: Array<{ commitFailure(): void; release(): void }> = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const reservation = limiter.reserve("source");
      expect(reservation.allowed, "Reservierung " + attempt).toBe(true);
      if (!reservation.allowed) {
        throw new Error("Reservierung erwartet");
      }
      tickets.push(reservation.ticket);
    }

    // Das alte Fenster ist abgelaufen, die drei Versuche laufen aber noch.
    now = 1001;
    const blockedByInFlight = limiter.reserve("source");
    expect(blockedByInFlight.allowed).toBe(false);
    expect(blockedByInFlight.remaining).toBe(0);

    // Zwei alte Versuche schlagen erst im neuen Fenster fehl und zaehlen dort.
    tickets[0].commitFailure();
    tickets[1].commitFailure();
    const blockedByFailures = limiter.reserve("source");
    expect(blockedByFailures.allowed).toBe(false);
    expect(blockedByFailures.remaining).toBe(0);

    // Erst nach Freigabe des letzten alten Versuchs ist wieder Platz.
    tickets[2].release();
    expect(limiter.peek("source").remaining).toBe(1);
    const allowedAgain = limiter.reserve("source");
    expect(allowedAgain.allowed).toBe(true);
    expect(allowedAgain.remaining).toBe(0);
    if (!allowedAgain.allowed) {
      throw new Error("Reservierung erwartet");
    }
    allowedAgain.ticket.release();

    // Die beiden bestaetigten Fehlversuche bleiben im neuen Fenster gezaehlt.
    const third = limiter.reserve("source");
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
    if (!third.allowed) {
      throw new Error("Reservierung erwartet");
    }
    third.ticket.release();

    // Im naechsten Fenster beginnt der Zaehler wieder bei null.
    now = 2002;
    const nextWindow = limiter.reserve("source");
    expect(nextWindow.allowed).toBe(true);
    expect(nextWindow.remaining).toBe(2);
    if (!nextWindow.allowed) {
      throw new Error("Reservierung erwartet");
    }
    nextWindow.ticket.release();
  });

});
