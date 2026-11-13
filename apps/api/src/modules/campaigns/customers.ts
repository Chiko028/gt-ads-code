import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ApiError } from "../../http/errors.js";
import { ADMIN_ACTOR_ID } from "../adminAuth/service.js";
import { AuditService } from "../audit/service.js";

/** Einziges Audit-Ereignis dieses Schritts. */
export const CUSTOMER_CREATED_ACTION = "customer.created";

/** Namensgrenzen nach R-204 (Teil 1). */
export const CUSTOMER_DISPLAY_NAME_MAX_LENGTH = 128;

/** Listenobergrenze und Standardwert. */
export const CUSTOMER_LIST_DEFAULT_LIMIT = 100;
export const CUSTOMER_LIST_MAX_LIMIT = 100;

/** Freigegebene Audit-Feldnamen; niemals Werte. */
export const CUSTOMER_AUDIT_FIELDS = Object.freeze(["display_name"] as const);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Customer {
  id: string;
  displayName: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

interface CustomerRow {
  id: string;
  display_name: string;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

export interface CreateCustomerInput {
  displayName: string;
  actorId?: string;
}

export interface CustomerServiceOptions {
  pool: Pool;
  /** Nur fuer deterministische Tests; Standard ist die vorhandene UUID-Quelle. */
  idFactory?: () => string;
}

const CUSTOMER_COLUMNS = [
  "id::text as id",
  "display_name",
  "revision",
  "created_at",
  "updated_at",
].join(", ");

/** Trimmt und prueft 1..128 Zeichen nach Trim. */
export function normalizeCustomerDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw ApiError.invalidRequest();
  }
  const trimmed = value.trim();
  const length = Array.from(trimmed).length;
  if (length < 1 || length > CUSTOMER_DISPLAY_NAME_MAX_LENGTH) {
    throw ApiError.invalidRequest();
  }
  return trimmed;
}

/** Akzeptiert ausschliesslich eine kanonische UUID. */
export function normalizeCustomerId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw ApiError.invalidRequest();
  }
  return value.toLowerCase();
}

/** Akzeptiert ausschliesslich ganze Zahlen 1..100. */
export function normalizeCustomerListLimit(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > CUSTOMER_LIST_MAX_LIMIT
  ) {
    throw ApiError.invalidRequest();
  }
  return value;
}

function toCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    displayName: row.display_name,
    revision: row.revision,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Kleiner parametrisierter SQL-Service des Kundenkerns. Anlegen und Audit
 * laufen auf demselben Transaktionsclient; ein Auditfehler rollt alles zurueck.
 */
export class CustomerService {
  private readonly pool: Pool;
  private readonly idFactory: () => string;
  private readonly audit: AuditService;

  constructor(options: CustomerServiceOptions) {
    this.pool = options.pool;
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.audit = new AuditService({ executor: this.pool });
  }

  async createCustomer(input: CreateCustomerInput): Promise<Customer> {
    const displayName = normalizeCustomerDisplayName(input.displayName);
    const actorId = input.actorId ?? ADMIN_ACTOR_ID;
    const id = this.idFactory();
    const client = await this.pool.connect();

    try {
      await client.query("begin");
      const result = await client.query<CustomerRow>(
        [
          "insert into customers (id, display_name)",
          "values ($1::uuid, $2)",
          "returning " + CUSTOMER_COLUMNS,
        ].join("\n"),
        [id, displayName],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("Kunde wurde nicht angelegt");
      }

      await this.audit.recordWith(
        client,
        {
          actorType: "admin",
          actorId,
          action: CUSTOMER_CREATED_ACTION,
          targetType: "customer",
          targetId: row.id,
          details: { fields: [...CUSTOMER_AUDIT_FIELDS] },
        },
        row.created_at,
      );

      await client.query("commit");
      return toCustomer(row);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getCustomer(id: string): Promise<Customer | null> {
    const customerId = normalizeCustomerId(id);
    const result = await this.pool.query<CustomerRow>(
      "select " + CUSTOMER_COLUMNS + " from customers where id = $1::uuid",
      [customerId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toCustomer(row);
  }

  async listCustomer(
    limit: number = CUSTOMER_LIST_DEFAULT_LIMIT,
  ): Promise<Customer[]> {
    const checkedLimit = normalizeCustomerListLimit(limit);
    const result = await this.pool.query<CustomerRow>(
      [
        "select " + CUSTOMER_COLUMNS,
        "  from customers",
        " order by id asc",
        " limit $1",
      ].join("\n"),
      [checkedLimit],
    );
    return result.rows.map(toCustomer);
  }
}
