import type { SqlQueryable, AuditActorType, AuditEventInput } from "./repository.js";
import { insertAuditEvent } from "./repository.js";

export interface AuditRecordInput {
  actorType: AuditActorType;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Einziger Schreibweg fuer Audit-Eintraege. Rohdaten aus Requests gelangen
 * nie direkt hierher; die Aufrufer bauen ein minimales Details-Objekt.
 */
export class AuditService {
  private readonly executor: SqlQueryable;
  private readonly now: () => Date;

  constructor(options: { executor: SqlQueryable; now?: () => Date }) {
    this.executor = options.executor;
    this.now = options.now ?? (() => new Date());
  }

  record(input: AuditRecordInput): Promise<void> {
    return insertAuditEvent(this.executor, { ...input, at: this.now() });
  }

  /** Fuer Transaktionen: schreibt auf denselben Client wie der Fachcode. */
  recordWith(
    executor: SqlQueryable,
    input: AuditRecordInput,
    at: Date,
  ): Promise<void> {
    const event: AuditEventInput = { ...input, at };
    return insertAuditEvent(executor, event);
  }
}
