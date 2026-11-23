package gtads.device.telemetry

import android.content.Context
import android.database.sqlite.SQLiteDatabase

/** Persistente Steuerung des Uploads: Sperre nach Auth-/Dauerfehler und Retry-After-Untergrenze. */
interface UploadGate {
    fun suspendedReason(): String?
    fun suspend(reason: String)
    fun resume()
    fun notBeforeMs(): Long
    fun setNotBeforeMs(value: Long)
}

class InMemoryUploadGate : UploadGate {
    private var reason: String? = null
    private var notBefore = 0L
    override fun suspendedReason(): String? = reason
    override fun suspend(reason: String) {
        this.reason = reason
    }
    override fun resume() {
        reason = null
    }
    override fun notBeforeMs(): Long = notBefore
    override fun setNotBeforeMs(value: Long) {
        notBefore = value
    }
}

class SharedPreferencesUploadGate(
    context: Context,
    preferencesName: String = DEFAULT_PREFERENCES_NAME,
) : UploadGate {
    private val preferences = context.applicationContext.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
    override fun suspendedReason(): String? = preferences.getString(KEY_REASON, null)
    override fun suspend(reason: String) {
        preferences.edit().putString(KEY_REASON, reason).commit()
    }
    override fun resume() {
        preferences.edit().remove(KEY_REASON).commit()
    }
    override fun notBeforeMs(): Long = preferences.getLong(KEY_NOT_BEFORE, 0L)
    override fun setNotBeforeMs(value: Long) {
        preferences.edit().putLong(KEY_NOT_BEFORE, value).commit()
    }
    private companion object {
        const val DEFAULT_PREFERENCES_NAME = "event-upload"
        const val KEY_REASON = "suspended"
        const val KEY_NOT_BEFORE = "not-before-ms"
    }
}

/** Ergebnis genau einer Worker-Ausfuehrung. */
sealed interface UploadOutcome {
    data object Empty : UploadOutcome
    data class Uploaded(val removed: Int, val remaining: Boolean) : UploadOutcome
    /** Voruebergehend; WorkManager-Backoff, Retry-After-Untergrenze ist gespeichert. */
    data object Retry : UploadOutcome
    /** Retry-After-Untergrenze noch nicht erreicht; kein Request. */
    data object Deferred : UploadOutcome
    /** Gesperrt (Auth/dauerhafte Ablehnung); keine automatische Wiederholung. */
    data class Stopped(val reason: String) : UploadOutcome
}

/**
 * Hintergrundanbindung des Ereignistransports (CX-094 / R-910).
 *
 * - Liest pro Ausfuehrung genau einen begrenzten Batch aus dem CX-084-Puffer,
 *   ohne waehrend des Requests eine Transaktion offen zu halten.
 * - Entfernt nach gueltiger Bestaetigung ausschliesslich die bestaetigten und
 *   im gesendeten Batch enthaltenen IDs in einer lokalen Transaktion.
 * - Keine Loeschung per Zeitstempel, keine Neuvergabe von IDs; nach Absturz
 *   werden dieselben IDs erneut gesendet (serverseitige Idempotenz CX-046).
 * - Auth-Fehler und dauerhafte Ablehnung behalten alle Daten und sperren die
 *   automatische Wiederholung bis zur erneuten gueltigen Registrierung.
 */
class EventUploadCoordinator(
    private val database: SQLiteDatabase,
    private val deviceId: String,
    private val send: (List<OutgoingEvent>) -> EventTransportResult,
    private val gate: UploadGate,
    private val wallClockMs: () -> Long = System::currentTimeMillis,
    private val batchSize: Int = DEFAULT_BATCH_SIZE,
    /** CX-160: Ereignispuffer oder Spot-Puffer; nur diese beiden Tabellen sind erlaubt. */
    private val table: String = TABLE_TELEMETRY_EVENTS,
) {
    init {
        require(table == TABLE_TELEMETRY_EVENTS || table == TABLE_SPOT_PLAYS) { "unsupported table" }
    }

    fun runOnce(): UploadOutcome {
        gate.suspendedReason()?.let { return UploadOutcome.Stopped(it) }
        if (wallClockMs() < gate.notBeforeMs()) return UploadOutcome.Deferred
        val batch = readBatch()
        if (batch.isEmpty()) return UploadOutcome.Empty
        val sentIds = batch.map { it.eventId }.toSet()
        return when (val result = send(batch)) {
            is EventTransportResult.Accepted -> {
                val confirmed = result.acceptedEventIds.intersect(sentIds)
                val removed = remove(confirmed)
                UploadOutcome.Uploaded(removed, remaining = hasRemaining())
            }
            is EventTransportResult.Retryable -> {
                result.retryAfterSeconds?.let { gate.setNotBeforeMs(wallClockMs() + it * 1000L) }
                UploadOutcome.Retry
            }
            EventTransportResult.AuthenticationRequired -> stop("authentifizierung")
            is EventTransportResult.Rejected -> stop("abgelehnt_" + result.status)
            EventTransportResult.InvalidInput -> stop("ungueltige_daten")
        }
    }

    private fun stop(reason: String): UploadOutcome {
        gate.suspend(reason)
        return UploadOutcome.Stopped(reason)
    }

    private fun readBatch(): List<OutgoingEvent> =
        database.rawQuery(
            "select event_id, payload_bytes from " + table + " where device_id = ? order by seq limit ?",
            arrayOf(deviceId, batchSize.toString()),
        ).use { cursor ->
            val list = ArrayList<OutgoingEvent>()
            while (cursor.moveToNext()) list += OutgoingEvent(cursor.getString(0), cursor.getBlob(1))
            list
        }

    private fun remove(ids: Set<String>): Int {
        if (ids.isEmpty()) return 0
        var removed = 0
        database.beginTransaction()
        try {
            for (id in ids) {
                removed += database.delete(table, "event_id = ? and device_id = ?", arrayOf(id, deviceId))
            }
            database.setTransactionSuccessful()
        } finally {
            database.endTransaction()
        }
        return removed
    }

    private fun hasRemaining(): Boolean =
        database.rawQuery("select 1 from " + table + " where device_id = ? limit 1", arrayOf(deviceId)).use { it.moveToFirst() }

    companion object {
        const val DEFAULT_BATCH_SIZE = 100
        const val TABLE_TELEMETRY_EVENTS = "telemetry_events"
        const val TABLE_SPOT_PLAYS = "spot_plays"
    }
}
