package gtads.device.control

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * Einzige lokale Zustandsquelle fuer R-905.
 *
 * Pausenzustand, Befehlsidentitaeten und ausstehende Quittungen liegen in
 * derselben Datenbank und werden vom Store in einer Transaktion geschrieben.
 */
class DeviceControlDatabase(
    context: Context,
    name: String = DEFAULT_DATABASE_NAME,
) : SQLiteOpenHelper(context, name, null, DATABASE_VERSION) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            "create table device_control_binding (" +
                "id integer primary key check (id = 1), " +
                "device_id text not null, " +
                "taxi_id text not null)",
        )
        db.execSQL(
            "create table device_control_state (" +
                "id integer primary key check (id = 1), " +
                "pause_paused integer not null check (pause_paused in (0, 1)), " +
                "pause_revision integer not null check (pause_revision >= 0), " +
                "pause_command_id text null, " +
                "pause_applied_at integer not null check (pause_applied_at >= 0), " +
                "config_revision integer not null check (config_revision >= 0), " +
                "config_gps_mode text null, " +
                "config_pause_max_duration_s integer null, " +
                "config_pause_end_on_vehicle_off integer null, " +
                "config_display_run_on_s integer null, " +
                "config_command_id text null, " +
                "config_applied_at integer null)",
        )
        db.execSQL(
            "create table device_control_commands (" +
                "command_id text primary key, " +
                "device_id text not null, " +
                "taxi_id text not null, " +
                "kind text not null check (kind in ('pause', 'config')), " +
                "revision integer not null check (revision >= 1), " +
                "desired_paused integer null check (" +
                "desired_paused is null or desired_paused in (0, 1)), " +
                "config_gps_mode text null, " +
                "config_pause_max_duration_s integer null, " +
                "config_pause_end_on_vehicle_off integer null, " +
                "config_display_run_on_s integer null, " +
                "applied_at integer not null)",
        )
        db.execSQL(
            "create unique index device_control_commands_revision_unique " +
                "on device_control_commands (device_id, taxi_id, kind, revision)",
        )
        db.execSQL(
            "create table device_control_pending_ack (" +
                "command_id text primary key, " +
                "device_id text not null, " +
                "taxi_id text not null, " +
                "revision integer not null check (revision >= 1), " +
                "created_at integer not null)",
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Version 1 ist der erste Stand. Es wird nie Zustand verworfen.
        if (oldVersion < 1) {
            onCreate(db)
        }
    }

    companion object {
        const val DEFAULT_DATABASE_NAME: String = "device-control.db"
        private const val DATABASE_VERSION: Int = 1
    }
}
