/**
 * Typisierter Client-Port der Taxi-Bedienung (CX-014).
 *
 * Die Begriffe folgen CX-012/CX-013: taxi_id, Tablet-IDs, gewuenschter
 * Pausenzustand, monotone Auftragsrevision, getrennte angewandte Revisionen
 * und versionierte Konfiguration. Es gibt hier bewusst keinen HTTP-Adapter,
 * keine URL und keinen fetch-Aufruf.
 */

export type TaxiTabletConnection = "online" | "offline";

export interface TaxiTablet {
  tablet_id: string;
  label: string;
  connection: TaxiTabletConnection;
}

export interface TaxiIdentity {
  taxi_id: string;
  taxi_name: string;
  /** In diesem Paket genau zwei Tablets je Taxi. */
  tablets: TaxiTablet[];
}

export interface AppliedRevision {
  tablet_id: string;
  revision: number;
}

export interface TaxiPauseStatus {
  desired_paused: boolean;
  /** Monotone Auftragsrevision des Taxis. */
  revision: number;
  command_id: string | null;
  /** Getrennte angewandte Revision je Tablet. */
  applied_revisions: AppliedRevision[];
  /**
   * Nur explizite endgueltige Zustellfehler des Ports. Offline allein ist
   * kein endgueltiger Fehler.
   */
  undeliverable_tablet_ids: string[];
}

export interface TaxiControlConfigValues {
  gps_mode: "aus";
  pause_max_duration_s: number | null;
  pause_end_on_vehicle_off: boolean | null;
  display_run_on_s: number | null;
}

export interface TaxiControlConfig extends TaxiControlConfigValues {
  taxi_id: string;
  revision: number;
  policy_complete: boolean;
}

export interface TaxiControlEntry {
  taxi: TaxiIdentity;
  pause: TaxiPauseStatus;
  config: TaxiControlConfig;
}

export interface TaxiControlSnapshot {
  taxis: TaxiControlEntry[];
}

export interface SetDesiredPauseInput {
  taxi_id: string;
  command_id: string;
  expected_revision: number;
  desired_paused: boolean;
}

export interface SetDesiredPauseResult {
  taxi_id: string;
  command_id: string;
  revision: number;
  desired_paused: boolean;
  applied_revisions?: AppliedRevision[];
  undeliverable_tablet_ids?: string[];
}

export interface UpdateTaxiConfigInput {
  taxi_id: string;
  change_id: string;
  expected_revision: number;
  config: TaxiControlConfigValues;
}

export interface UpdateTaxiConfigResult extends TaxiControlConfig {
  change_id: string;
}

/**
 * Injizierter Port. Ein Produktionsadapter folgt erst mit einer separat
 * spezifizierten Kommunikationsschnittstelle.
 */
export interface TaxiControlClient {
  load(): Promise<TaxiControlSnapshot>;
  setDesiredPause(input: SetDesiredPauseInput): Promise<SetDesiredPauseResult>;
  updateTaxiConfig(
    input: UpdateTaxiConfigInput,
  ): Promise<UpdateTaxiConfigResult>;
}

export type TaxiControlErrorKind =
  | "unclear"
  | "network"
  | "revision_conflict"
  | "forbidden"
  | "invalid_request"
  | "server";

/** Bereinigter Portfehler; die Komponente wertet ausschliesslich kind aus. */
export class TaxiControlPortError extends Error {
  readonly kind: TaxiControlErrorKind;

  constructor(kind: TaxiControlErrorKind, message?: string) {
    super(message ?? kind);
    this.name = "TaxiControlPortError";
    this.kind = kind;
  }
}

const ERROR_KINDS: TaxiControlErrorKind[] = [
  "unclear",
  "network",
  "revision_conflict",
  "forbidden",
  "invalid_request",
  "server",
];

export function isTaxiControlPortError(
  error: unknown,
): error is TaxiControlPortError {
  if (error instanceof TaxiControlPortError) {
    return true;
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const kind = (error as { kind?: unknown }).kind;
  return (
    typeof kind === "string" &&
    ERROR_KINDS.includes(kind as TaxiControlErrorKind)
  );
}
