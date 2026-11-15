import { AsyncLocalStorage } from "node:async_hooks";

/**
 * CX-052: Die Fastify-Request-ID gehoert zum HTTP-Aufruf, nicht zum
 * fachlichen Pausenkern. Der Adapter traegt sie fuer die Dauer des Aufrufs
 * im asynchronen Kontext, damit der Audit-Writer sie im selben
 * Transaktionsdatensatz ablegen kann.
 */
const requestIdStorage = new AsyncLocalStorage<string>();

export function runWithRequestId<T>(
  requestId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return requestIdStorage.run(requestId, fn);
}

export function currentRequestId(): string | undefined {
  return requestIdStorage.getStore();
}
