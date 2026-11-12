/** SQL des Pausenauftragskerns. Alle Schreibwege laufen in einer Transaktion. */

export interface TaxiStateRow {
  revision: string;
}

export interface CommandRow {
  command_id: string;
  taxi_id: string;
  revision: string;
  desired_paused: boolean;
  origin: string;
  actor_id: string;
  content_fingerprint: string;
  issued_at: Date;
}

export interface DeliveryRow {
  id: string;
  command_id: string;
  taxi_id: string;
  revision: string;
  status: "pending" | "applied" | "superseded";
  acknowledged_at: Date | null;
}

export interface PendingRow {
  command_id: string;
  taxi_id: string;
  revision: string;
  desired_paused: boolean;
  origin: string;
  issued_at: Date;
}

export interface DeviceStateRow {
  id: string;
  state: string;
}

export const INSERT_TAXI_STATE_SQL = [
  "insert into remote_control_taxi_state",
  "  (taxi_id, revision, desired_paused, updated_at)",
  "values ($1, 0, false, $2)",
  "on conflict (taxi_id) do nothing",
].join("\n");

export const LOCK_TAXI_STATE_SQL = [
  "select revision::text as revision",
  "  from remote_control_taxi_state",
  " where taxi_id = $1",
  "   for update",
].join("\n");

export const SELECT_COMMAND_SQL = [
  "select command_id::text as command_id, taxi_id, revision::text as revision,",
  "       desired_paused, origin, actor_id, content_fingerprint, issued_at",
  "  from remote_control_commands",
  " where command_id = $1",
].join("\n");

export const SELECT_COMMAND_DEVICES_SQL = [
  "select device_id::text as device_id",
  "  from remote_control_deliveries",
  " where command_id = $1",
  " order by device_id",
].join("\n");

export const SELECT_TAXI_DEVICES_SQL = [
  "select id::text as id, state",
  "  from devices",
  " where id = any($1::uuid[])",
].join("\n");

export const SELECT_DEVICE_SQL = [
  "select id::text as id, state",
  "  from devices",
  " where id = $1",
].join("\n");

export const SUPERSEDE_PENDING_SQL = [
  "update remote_control_deliveries",
  "   set status = 'superseded', superseded_at = $2",
  " where taxi_id = $1",
  "   and status = 'pending'",
].join("\n");

export const INSERT_COMMAND_SQL = [
  "insert into remote_control_commands",
  "  (command_id, taxi_id, revision, desired_paused, origin, actor_id,",
  "   content_fingerprint, issued_at)",
  "values ($1, $2, $3, $4, $5, $6, $7, $8)",
].join("\n");

export const UPDATE_TAXI_STATE_SQL = [
  "update remote_control_taxi_state",
  "   set revision = $2, desired_paused = $3, updated_at = $4",
  " where taxi_id = $1",
].join("\n");

export const INSERT_DELIVERY_SQL = [
  "insert into remote_control_deliveries",
  "  (command_id, taxi_id, device_id, revision, status, created_at)",
  "values ($1, $2, $3, $4, 'pending', $5)",
].join("\n");

export const SELECT_PENDING_SQL = [
  "select d.command_id::text as command_id, d.taxi_id,",
  "       d.revision::text as revision, c.desired_paused, c.origin,",
  "       c.issued_at",
  "  from remote_control_deliveries d",
  "  join remote_control_commands c on c.command_id = d.command_id",
  " where d.device_id = $1",
  "   and d.taxi_id = $2",
  "   and d.status = 'pending'",
  " order by d.revision desc, d.id desc",
  " limit 1",
].join("\n");

export const SELECT_DELIVERY_FOR_ACK_SQL = [
  "select id::text as id, command_id::text as command_id, taxi_id,",
  "       revision::text as revision, status, acknowledged_at",
  "  from remote_control_deliveries",
  " where device_id = $1",
  "   and taxi_id = $2",
  "   and revision = $3",
  " order by id desc",
  " limit 1",
  "   for update",
].join("\n");

export const UPDATE_DELIVERY_APPLIED_SQL = [
  "update remote_control_deliveries",
  "   set status = 'applied', acknowledged_at = $2",
  " where id = $1",
  "   and status = 'pending'",
  "returning id::text as id",
].join("\n");
