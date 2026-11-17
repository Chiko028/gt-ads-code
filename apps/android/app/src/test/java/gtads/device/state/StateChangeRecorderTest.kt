package gtads.device.state

import android.database.sqlite.SQLiteDatabase
import gtads.device.telemetry.TelemetryEventDatabase
import java.time.Instant
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Robolectric-Integrationstest der dauerhaften Pufferung (CX-085 / CX-084).
 *
 * Prueft genau eine Pufferzeile je tatsaechlichem Zustandswechsel, die
 * CX-046-Nutzdaten, die idempotente Wirkung wiederholter Lifecycle-Starts
 * und die Sichtbarkeit von Speicherfehlern.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class StateChangeRecorderTest {

    private val fixedTime = Instant.parse("2026-11-17T06:44:00Z")
    private val openDatabases = mutableListOf<SQLiteDatabase>()
    private var databaseCounter = 0

    @After
    fun closeDatabases() {
        openDatabases.forEach { if (it.isOpen) it.close() }
        openDatabases.clear()
    }

    private class FakeReadiness(private var value: VehicleReadiness) : ReadinessSource {
        var starts = 0
        private var observer: ((VehicleReadiness) -> Unit)? = null

        override fun current(): VehicleReadiness = value

        override fun start(observer: (VehicleReadiness) -> Unit) {
            starts += 1
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

    private fun newDatabase(): SQLiteDatabase {
        databaseCounter += 1
        val name = "telemetry-events-" + databaseCounter + "-" + System.nanoTime() + ".db"
        val database = TelemetryEventDatabase(
            RuntimeEnvironment.getApplication(),
            name,
        ).writableDatabase
        openDatabases += database
        return database
    }

    private fun count(database: SQLiteDatabase): Long =
        database.rawQuery("select count(*) from telemetry_events", null).use { cursor ->
            cursor.moveToFirst()
            cursor.getLong(0)
        }

    private fun payloads(database: SQLiteDatabase): List<JSONObject> {
        val result = mutableListOf<JSONObject>()
        database.rawQuery(
            "select payload_bytes from telemetry_events order by seq",
            null,
        ).use { cursor ->
            while (cursor.moveToNext()) {
                result += JSONObject(String(cursor.getBlob(0), Charsets.UTF_8))
            }
        }
        return result
    }

    @Test
    fun oneTransitionIsBufferedExactlyOnceAndRepeatedStartAddsNoObserverOrRow() {
        val database = newDatabase()
        val readiness = FakeReadiness(VehicleReadiness.UNKNOWN)
        var eventCounter = 0
        val decisions = mutableListOf<GateDecision>()
        val coordinator = PlaybackStateCoordinator(
            machine = PlaybackStateMachine(clock = { 1_000L }),
            readiness = readiness,
            content = { ContentAvailability.VALID },
            recorder = {
                StateChangeRecorder(
                    database = database,
                    deviceId = "device-a",
                    clock = { fixedTime },
                    newEventId = { "event-" + (++eventCounter) },
                )
            },
            onDecision = { decisions += it },
        )

        coordinator.start()
        assertEquals("Initialstand ist kein Wechsel", 0L, count(database))

        readiness.emit(VehicleReadiness.ON)
        assertEquals(1L, count(database))

        // Wiederholter Lifecycle-Start registriert keinen zweiten Beobachter.
        coordinator.start()
        assertEquals(1, readiness.starts)

        // Erneutes Auswerten desselben Zustands erzeugt keine zweite Zeile.
        coordinator.refresh()
        assertEquals(1L, count(database))

        readiness.emit(VehicleReadiness.OFF)
        assertEquals(2L, count(database))

        // Nach echtem Stop und Neustart bleibt der Stand ohne Duplikat.
        coordinator.stop()
        coordinator.start()
        assertEquals(2L, count(database))
        assertEquals(2, readiness.starts)

        val first = payloads(database).first()
        assertTrue(first.getString("event_id").isNotEmpty())
        assertEquals("2026-11-17T06:44:00.000Z", first.getString("occurred_at"))
        assertTrue(first.getBoolean("vehicle_ready"))
        assertFalse(first.getBoolean("paused"))
        assertEquals("playing", first.getString("playback"))
        assertFalse(first.getBoolean("technical_fault"))
        assertEquals(
            setOf(
                "event_id",
                "occurred_at",
                "vehicle_ready",
                "paused",
                "playback",
                "technical_fault",
            ),
            first.keys().asSequence().toSet(),
        )

        val second = payloads(database)[1]
        assertFalse(second.getBoolean("vehicle_ready"))
        assertEquals("stopped", second.getString("playback"))
        assertEquals(DecisionReason.VEHICLE_OFF, decisions.last().reason)
    }

    @Test
    fun storageFailureIsVisibleAndDoesNotChangePlaybackDecision() {
        val database = newDatabase()
        database.close()
        val readiness = FakeReadiness(VehicleReadiness.UNKNOWN)
        var reported: String? = null
        val coordinator = PlaybackStateCoordinator(
            machine = PlaybackStateMachine(clock = { 2_000L }),
            readiness = readiness,
            content = { ContentAvailability.VALID },
            recorder = { StateChangeRecorder(database, "device-a", clock = { fixedTime }) },
            onStorageError = { reported = it },
        )
        coordinator.start()
        readiness.emit(VehicleReadiness.ON)

        assertNotNull("Speicherfehler muessen sichtbar sein", coordinator.storageError)
        assertNotNull(reported)
        // Die Wiedergabeentscheidung bleibt davon unberuehrt.
        assertTrue(coordinator.decision()!!.playbackAllowed)
        assertEquals(DecisionReason.PLAYING, coordinator.decision()!!.reason)
    }
}
