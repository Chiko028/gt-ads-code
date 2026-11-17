package gtads.device.state

import android.database.sqlite.SQLiteDatabase
import gtads.device.telemetry.EventAppendStore
import gtads.device.telemetry.TelemetryEventDatabase
import java.time.Instant
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** CX-099: serialisierte periodische Statusberichte mit injizierter Uhr und echtem Puffer. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PeriodicStatusTest {
    private val open = mutableListOf<SQLiteDatabase>()
    private var now = Instant.parse("2026-11-17T09:00:00Z")
    private var ids = 0

    @After
    fun tearDown() {
        open.forEach { if (it.isOpen) it.close() }
    }

    private class Readiness(var value: VehicleReadiness) : ReadinessSource {
        private var observer: ((VehicleReadiness) -> Unit)? = null
        override fun current(): VehicleReadiness = value
        override fun start(observer: (VehicleReadiness) -> Unit) {
            this.observer = observer
        }
        override fun stop() {
            observer = null
        }
        fun emit(next: VehicleReadiness) {
            value = next
            observer?.invoke(next)
        }
    }

    private fun database(): SQLiteDatabase =
        TelemetryEventDatabase(RuntimeEnvironment.getApplication(), "cx099-${System.nanoTime()}.db")
            .writableDatabase.also { open += it }

    private fun rows(db: SQLiteDatabase): List<JSONObject> =
        db.rawQuery("select payload_bytes from telemetry_events order by seq", null).use { c ->
            val list = ArrayList<JSONObject>()
            while (c.moveToNext()) list += JSONObject(String(c.getBlob(0), Charsets.UTF_8))
            list
        }

    private fun coordinator(
        readiness: Readiness,
        recorder: () -> StateChangeRecorder?,
        mark: PeriodicStatusMark,
    ) = PlaybackStateCoordinator(
        machine = PlaybackStateMachine(StateMachineConfig(), clock = { now.toEpochMilli() }),
        readiness = readiness,
        content = { ContentAvailability.VALID },
        recorder = recorder,
        periodicMark = mark,
        wallClock = { now },
        newEventId = { "00000000-0000-4000-8000-%012d".format(++ids) },
    )

    @Test
    fun missedIntervalsCollapseIntoAtMostOneCurrentReport() {
        val db = database()
        val recorder = StateChangeRecorder(db, "SYN-device", clock = { now })
        val mark = InMemoryPeriodicStatusMark()
        val readiness = Readiness(VehicleReadiness.ON)
        val gate = coordinator(readiness, { recorder }, mark)
        gate.start()

        gate.periodicTick()
        assertEquals(1, rows(db).size)
        assertEquals(now, mark.lastStored())

        // Fuenf Intervalle ausgefallen (z. B. App im Hintergrund), dann Wiederaufnahme.
        now = now.plusMillis(5 * DEFAULT_PERIODIC_INTERVAL_MILLIS + 1_000L)
        gate.periodicTick()
        gate.periodicTick()
        assertEquals(2, rows(db).size)
        assertEquals("2026-11-17T11:30:01.000Z", rows(db).last().getString("occurred_at"))

        // Vor Ablauf des naechsten Intervalls kein weiterer Bericht.
        now = now.plusMillis(DEFAULT_PERIODIC_INTERVAL_MILLIS - 1L)
        gate.periodicTick()
        assertEquals(2, rows(db).size)
    }

    @Test
    fun failedInsertKeepsMarkAndRetryUsesSameEventIdExactlyOnce() {
        val db = database()
        // Gezielt fehlschlagende Speichergrenze: Kapazitaet 1, bereits belegt.
        db.beginTransaction()
        try {
            EventAppendStore(db).append("SYN-belegt", "SYN-device", byteArrayOf(1))
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        val recorder = StateChangeRecorder(db, "SYN-device", clock = { now }, store = EventAppendStore(db, capacity = 1))
        val mark = InMemoryPeriodicStatusMark()
        val gate = coordinator(Readiness(VehicleReadiness.ON), { recorder }, mark)
        gate.start()

        gate.periodicTick()
        assertNull(mark.lastStored())
        assertEquals("puffer_full", gate.storageError)
        val firstId = ids

        // Speicher wird frei; der naechste Ausloeser wiederholt denselben Bericht.
        db.delete("telemetry_events", "event_id = ?", arrayOf("SYN-belegt"))
        val retryAt = now.plusSeconds(60)
        now = retryAt
        gate.periodicTick()
        gate.periodicTick()

        val stored = rows(db)
        assertEquals(1, stored.size)
        assertEquals("00000000-0000-4000-8000-%012d".format(firstId), stored.single().getString("event_id"))
        assertEquals("2026-11-17T09:00:00.000Z", stored.single().getString("occurred_at"))
        assertEquals(firstId, ids)
        assertEquals(retryAt, mark.lastStored())
    }

    @Test
    fun simultaneousStateChangeAndPeriodicTickLoseNothingAndReportOnce() {
        val db = database()
        val recorder = StateChangeRecorder(db, "SYN-device", clock = { now })
        val mark = InMemoryPeriodicStatusMark(now.minusMillis(DEFAULT_PERIODIC_INTERVAL_MILLIS))
        val readiness = Readiness(VehicleReadiness.ON)
        val gate = coordinator(readiness, { recorder }, mark)
        gate.start()

        // Zustandswechsel trifft ohne Beobachter-Benachrichtigung ein, zeitgleich mit dem Termin.
        readiness.value = VehicleReadiness.OFF
        val threads = (1..2).map { Thread { gate.periodicTick() } }
        threads.forEach { it.start() }
        threads.forEach { it.join() }
        readiness.emit(VehicleReadiness.OFF)

        val stored = rows(db)
        // Genau ein Zustandsereignis plus hoechstens ein periodischer Bericht.
        assertEquals(2, stored.size)
        stored.forEach { assertEquals(false, it.get("vehicle_ready")) }
        assertEquals(now, mark.lastStored())
    }
}
