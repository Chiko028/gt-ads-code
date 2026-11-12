/** SQL der versionierten Pausenkonfiguration. Schreibwege laufen in einer Transaktion. */

export interface ControlConfigRow {
  revision: string;
  gps_mode: string;
  pause_max_duration_s: string | null;
  pause_end_on_vehicle_off: boolean | null;
  display_run_on_s: string | null;
}

export interface ControlConfigChangeRow extends ControlConfigRow {
  change_id: string;
  taxi_id: string;
  content_fingerprint: string;
}

const CONFIG_COLUMNS = [
  "revision::text as revision",
  "gps_mode",
  "pause_max_duration_s::text as pause_max_duration_s",
  "pause_end_on_vehicle_off",
  "display_run_on_s::text as display_run_on_s",
].join(", ");

export const SELECT_CONFIG_SQL = [
  "select " + CONFIG_COLUMNS,
  "  from control_config_taxi",
  " where taxi_id = $1",
].join("\n");

export const INSERT_DEFAULT_CONFIG_SQL = [
  "insert into control_config_taxi",
  "  (taxi_id, revision, gps_mode, pause_max_duration_s,",
  "   pause_end_on_vehicle_off, display_run_on_s, updated_at)",
  "values ($1, 0, 'aus', null, null, null, $2)",
  "on conflict (taxi_id) do nothing",
].join("\n");

export const LOCK_CONFIG_SQL = [
  "select " + CONFIG_COLUMNS,
  "  from control_config_taxi",
  " where taxi_id = $1",
  "   for update",
].join("\n");

export const SELECT_CHANGE_SQL = [
  "select change_id::text as change_id, taxi_id, content_fingerprint,",
  "       " + CONFIG_COLUMNS.replace(/, /g, ",\n       "),
  "  from control_config_changes",
  " where change_id = $1",
].join("\n");

export const UPDATE_CONFIG_SQL = [
  "update control_config_taxi",
  "   set revision = $2, gps_mode = $3, pause_max_duration_s = $4,",
  "       pause_end_on_vehicle_off = $5, display_run_on_s = $6,",
  "       updated_at = $7",
  " where taxi_id = $1",
].join("\n");

export const INSERT_CHANGE_SQL = [
  "insert into control_config_changes",
  "  (change_id, taxi_id, revision, content_fingerprint, actor_id,",
  "   gps_mode, pause_max_duration_s, pause_end_on_vehicle_off,",
  "   display_run_on_s, applied_at)",
  "values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
].join("\n");
