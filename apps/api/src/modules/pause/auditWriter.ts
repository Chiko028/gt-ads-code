import {
  insertAuditEvent,
  type AuditEventInput,
} from "../audit/repository.js";
import type { RemoteControlAuditWriter } from "../remoteControl/index.js";
import { currentRequestId } from "./requestContext.js";

/**
 * CX-052: Der vorhandene CX-012-Kern kennt keine Request-ID. Der Adapter
 * nutzt dessen vorhandenen Audit-Writer-Hook und ergaenzt die
 * Fastify-Request-ID im selben Audit-Datensatz und derselben Transaktion.
 * Der Kern unter modules/remoteControl/ bleibt unveraendert.
 */
export function createRequestAuditWriter(): RemoteControlAuditWriter {
  return async (executor, event) => {
    const requestId = currentRequestId();
    if (requestId === undefined) {
      await insertAuditEvent(executor, event);
      return;
    }
    const details: AuditEventInput["details"] = {
      ...(event.details ?? {}),
      request_id: requestId,
    };
    await insertAuditEvent(executor, { ...event, details });
  };
}
