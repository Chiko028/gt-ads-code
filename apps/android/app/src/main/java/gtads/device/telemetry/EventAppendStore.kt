package gtads.device.telemetry

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import java.util.Arrays

/**
 * Fuegt Telemetrieereignisse idempotent in eine bestehende SQLite-Schreibtransaktion ein.
 * Dauerhaftigkeit entsteht erst durch den erfolgreichen Commit des Aufrufers.
 */
class EventAppendStore(
    private val database: SQLiteDatabase,
    capacity: Int = DEFAULT_CAPACITY,
) {
    private val capacity: Int

    init {
        require(capacity > 0) { "capacity must be positive" }
        this.capacity = capacity
    }

    enum class AppendResult { inserted, already_present, conflict, full }

    fun append(eventId: String, deviceId: String, payloadBytes: ByteArray): AppendResult {
        require(eventId.isNotEmpty()) { "eventId must not be empty" }
        require(payloadBytes.isNotEmpty()) { "payloadBytes must not be empty" }
        check(database.inTransaction()) { "append requires an open caller transaction" }
        val bytes = payloadBytes.copyOf()
        database.rawQuery(
            "select device_id, payload_bytes from telemetry_events where event_id = ?",
            arrayOf(eventId),
        ).use { cursor ->
            if (cursor.moveToFirst()) {
                val sameBytes = Arrays.equals(cursor.getBlob(1), bytes)
                return if (cursor.getString(0) == deviceId && sameBytes) {
                    AppendResult.already_present
                } else {
                    AppendResult.conflict
                }
            }
        }
        if (rowCount() >= capacity) return AppendResult.full
        val values = ContentValues()
        values.put("event_id", eventId)
        values.put("device_id", deviceId)
        values.put("payload_bytes", bytes)
        database.insertOrThrow("telemetry_events", null, values)
        return AppendResult.inserted
    }

    private fun rowCount(): Int =
        database.rawQuery("select count(*) from telemetry_events", null).use { cursor ->
            cursor.moveToFirst()
            cursor.getInt(0)
        }

    companion object {
        const val DEFAULT_CAPACITY = 100000
    }
}
