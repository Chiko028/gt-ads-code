package gtads.device.spotplay

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import gtads.device.playback.SpotPlayRecord
import org.json.JSONObject
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.UUID

/**
 * CX-160: lokaler Puffer der Abspielnachweise.
 *
 * Die Tabelle hat exakt die Spaltenstruktur des Ereignispuffers (CX-084), damit
 * derselbe Uploadkoordinator sie lesen und bestaetigte Eintraege loeschen kann.
 * Die lokale event_id ist die play_id der Meldung; sie wird nur einmal vergeben
 * und nie neu erzeugt.
 */
class SpotPlayDatabase(
    context: Context,
    name: String = DEFAULT_DATABASE_NAME,
) : SQLiteOpenHelper(context, name, null, DATABASE_VERSION) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            "create table spot_plays (" +
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
        const val DEFAULT_DATABASE_NAME: String = "spot-plays.db"
        private const val DATABASE_VERSION: Int = 1
    }
}

/** Ergebnis genau einer Pufferaufnahme; nur [inserted] erzeugt eine Zeile. */
enum class SpotPlayAppend {
    inserted,

    /** Keine UUID, keine positive Dauer oder Dauer ausserhalb der Servergrenze. */
    invalid,

    /** Pufferkapazitaet erreicht; der Nachweis wird nicht verdraengt. */
    full,
}

/**
 * CX-160: validiert und puffert einen beendeten Spot.
 *
 * - Nicht-UUIDs fuer Kampagne und Video werden verworfen.
 * - 0 ms (und negative Dauern) werden verworfen; Dauern ueber der Serverobergrenze
 *   ebenfalls, damit kein sicher abgelehnter Batch entsteht.
 * - ended_at ist exakt started_at + played_ms (UTC, Millisekunden).
 * - Die Nutzdaten enthalten genau das Serverschema von /v1/device/spot-plays.
 * - Es gibt keine Verdraengung: bei voller Kapazitaet bleibt der Altbestand.
 */
class SpotPlayRecorder(
    private val database: SQLiteDatabase,
    private val deviceId: String,
    capacity: Int = DEFAULT_CAPACITY,
) {
    private val capacity: Int

    init {
        require(capacity > 0) { "capacity must be positive" }
        this.capacity = capacity
    }

    fun record(record: SpotPlayRecord): SpotPlayAppend {
        val campaignId = normalizeUuid(record.campaignId) ?: return SpotPlayAppend.invalid
        val mediaId = normalizeUuid(record.mediaId) ?: return SpotPlayAppend.invalid
        if (record.playedMs <= 0L || record.playedMs > MAX_PLAYED_MS) return SpotPlayAppend.invalid
        val endedAt = try {
            record.startedAt.plusMillis(record.playedMs)
        } catch (_: Exception) {
            return SpotPlayAppend.invalid
        }
        val playId = UUID.randomUUID().toString()
        val payload = JSONObject()
            .put("play_id", playId)
            .put("campaign_id", campaignId)
            .put("media_id", mediaId)
            .put("started_at", TIMESTAMP.format(record.startedAt))
            .put("ended_at", TIMESTAMP.format(endedAt))
            .put("played_ms", record.playedMs)
            .put("completed", record.completed)
            .toString()
            .toByteArray(Charsets.UTF_8)

        database.beginTransaction()
        try {
            if (rowCount() >= capacity) return SpotPlayAppend.full
            val values = ContentValues()
            values.put("event_id", playId)
            values.put("device_id", deviceId)
            values.put("payload_bytes", payload)
            database.insertOrThrow("spot_plays", null, values)
            database.setTransactionSuccessful()
            return SpotPlayAppend.inserted
        } finally {
            database.endTransaction()
        }
    }

    private fun rowCount(): Int =
        database.rawQuery("select count(*) from spot_plays", null).use { cursor ->
            cursor.moveToFirst()
            cursor.getInt(0)
        }

    companion object {
        const val DEFAULT_CAPACITY = 100_000
        /** Serverseitige Obergrenze (CX-159: spot_plays_played_ms_range). */
        const val MAX_PLAYED_MS = 3_600_000L
        private val TIMESTAMP =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)
        private val UUID_PATTERN = Regex(
            "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
        )

        private fun normalizeUuid(raw: String): String? =
            if (UUID_PATTERN.matches(raw)) raw.lowercase() else null
    }
}
