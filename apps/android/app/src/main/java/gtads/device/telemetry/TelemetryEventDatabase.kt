package gtads.device.telemetry

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * Ablage der dauerhaft gepufferten Ereignisse (CX-084 / R-904).
 *
 * Das Schema entspricht exakt dem vom [EventAppendStore] erwarteten
 * telemetry_events-Bestand. Es gibt keine Loesch- oder Verdraengungslogik.
 */
class TelemetryEventDatabase(
    context: Context,
    name: String = DEFAULT_DATABASE_NAME,
) : SQLiteOpenHelper(context, name, null, DATABASE_VERSION) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            "create table telemetry_events (" +
                "seq integer primary key autoincrement, " +
                "event_id text not null unique, " +
                "device_id text not null, " +
                "payload_bytes blob not null)",
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < DATABASE_VERSION) onCreate(db)
    }

    companion object {
        const val DEFAULT_DATABASE_NAME: String = "telemetry-events.db"
        private const val DATABASE_VERSION: Int = 1
    }
}
