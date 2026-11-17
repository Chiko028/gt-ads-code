package gtads.device.state

import android.database.sqlite.SQLiteDatabase
import gtads.device.telemetry.EventAppendStore
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.UUID
import org.json.JSONObject

/** Ergebnis eines Puffervorgangs; jede Kategorie ist ohne Rohdaten sichtbar. */
enum class StateChangeRecordResult {
    stored,
    duplicate,
    conflict,
    full,
    unavailable,
}

/**
 * Schreibt tatsaechliche Zustandswechsel ueber den CX-084-Puffer.
 *
 * Die Nutzdaten verwenden ausschliesslich die vorhandenen CX-046-Felder
 * event_id, occurred_at, vehicle_ready, paused, playback und technical_fault.
 * Es werden keine neuen Servertypen und keine erfundenen Fahrzeugzustaende
 * erzeugt: unbekannte Bereitschaft wird als vehicle_ready = null geschrieben.
 *
 * Der Aufrufer entscheidet ueber den Zeitpunkt; der Store fuehrt genau eine
 * Transaktion aus und committet sie.
 */
class StateChangeRecorder(
    private val database: SQLiteDatabase,
    private val deviceId: String,
    private val clock: () -> Instant = Instant::now,
    private val newEventId: () -> String = { UUID.randomUUID().toString() },
    private val store: EventAppendStore = EventAppendStore(database),
) {
    init {
        require(deviceId.isNotBlank()) { "deviceId must not be blank" }
    }

    fun record(snapshot: StateSnapshot, vehicle: VehicleReadiness): StateChangeRecordResult =
        record(snapshot, vehicle, newEventId(), clock())

    /**
     * CX-099: Schreibt mit vorgegebener Ereignis-ID und Zeitpunkt. Eine
     * Wiederholung desselben Berichts nutzt dieselben Bytes und bleibt durch
     * die idempotente Insert-Funktion genau einmal gespeichert.
     */
    fun record(
        snapshot: StateSnapshot,
        vehicle: VehicleReadiness,
        eventId: String,
        occurredAt: Instant,
    ): StateChangeRecordResult {
        val payload = payload(snapshot, vehicle, eventId, occurredAt(occurredAt))
        database.beginTransaction()
        try {
            val appended = store.append(payload.first, deviceId, payload.second)
            database.setTransactionSuccessful()
            return when (appended) {
                EventAppendStore.AppendResult.inserted -> StateChangeRecordResult.stored
                EventAppendStore.AppendResult.already_present -> StateChangeRecordResult.duplicate
                EventAppendStore.AppendResult.conflict -> StateChangeRecordResult.conflict
                EventAppendStore.AppendResult.full -> StateChangeRecordResult.full
            }
        } finally {
            database.endTransaction()
        }
    }

    private fun payload(
        snapshot: StateSnapshot,
        vehicle: VehicleReadiness,
        eventId: String,
        occurredAt: String,
    ): Pair<String, ByteArray> {
        val json = JSONObject()
        json.put("event_id", eventId)
        json.put("occurred_at", occurredAt)
        when (vehicle) {
            VehicleReadiness.ON -> json.put("vehicle_ready", true)
            VehicleReadiness.OFF -> json.put("vehicle_ready", false)
            VehicleReadiness.UNKNOWN -> json.put("vehicle_ready", JSONObject.NULL)
        }
        json.put("paused", snapshot.pauseEffective)
        json.put(
            "playback",
            if (snapshot.playbackAllowed) PLAYBACK_PLAYING else PLAYBACK_STOPPED,
        )
        json.put("technical_fault", snapshot.reason == DecisionReason.PLAYER_ERROR)
        return eventId to json.toString().toByteArray(Charsets.UTF_8)
    }

    private fun occurredAt(instant: Instant): String =
        FORMAT.format(instant.atOffset(ZoneOffset.UTC))

    companion object {
        private const val PLAYBACK_PLAYING = "playing"
        private const val PLAYBACK_STOPPED = "stopped"
        private val FORMAT: DateTimeFormatter =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
    }
}
