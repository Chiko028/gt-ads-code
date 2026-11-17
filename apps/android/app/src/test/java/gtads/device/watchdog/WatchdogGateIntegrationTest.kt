package gtads.device.watchdog

import android.database.sqlite.SQLiteDatabase
import android.view.View
import gtads.device.playback.FakePlaybackTimer
import gtads.device.playback.LocalMediaPlayerAdapter
import gtads.device.playback.LocalPlayerPort
import gtads.device.playback.MutableClock
import gtads.device.playback.PlaybackController
import gtads.device.playback.manifestSlot
import gtads.device.playback.mediaFixture
import gtads.device.playback.snapshotOf
import gtads.device.state.ContentAvailability
import gtads.device.state.DecisionReason
import gtads.device.state.PauseRestore
import gtads.device.state.PlaybackStateCoordinator
import gtads.device.state.PlaybackStateMachine
import gtads.device.state.PlayerCondition
import gtads.device.state.ReadinessSource
import gtads.device.state.StateChangeRecorder
import gtads.device.state.StateMachineConfig
import gtads.device.state.VehicleReadiness
import gtads.device.telemetry.TelemetryEventDatabase
import java.io.File
import java.time.Instant
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * REV-199: Watchdog mit der produktiven Rueckkopplung wie in MainActivity: Fehlerzustand ->
 * PlayerCondition des echten PlaybackStateCoordinator -> Wiedergabefreigabe des Controllers;
 * Meldung des technischen Zustands ueber den echten Zustandspuffer (StateChangeRecorder).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WatchdogGateIntegrationTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private var mono = 0L
    private val start = Instant.parse("2026-12-01T10:00:00Z")
    private val databases = mutableListOf<SQLiteDatabase>()

    @After
    fun tearDown() {
        databases.forEach { if (it.isOpen) it.close() }
    }

    private class Port : LocalPlayerPort {
        var position = 0L
        var plays = 0
        var releases = 0
        var onRelease: () -> Unit = {}
        override fun setCallbacks(callbacks: LocalPlayerPort.Callbacks?) {}
        override fun disableAudio() {}
        override fun prepare(file: File, generation: Long) {}
        override fun play() { plays++ }
        override fun stop() {}
        override fun release() { releases++; onRelease() }
        override fun attachView(view: View?) {}
        override fun currentPositionMs(): Long = position
    }

    private class Scheduler {
        val active = ArrayList<() -> Unit>()
        fun schedule(delay: Long, action: () -> Unit): AutoCloseable {
            active += action
            return AutoCloseable { active.remove(action) }
        }
        fun fire() { if (active.isNotEmpty()) active.removeAt(0)() }
    }

    private class Readiness : ReadinessSource {
        override fun current() = VehicleReadiness.ON
        override fun start(observer: (VehicleReadiness) -> Unit) = Unit
        override fun stop() = Unit
    }

    private inner class Rig {
        val port = Port()
        val scheduler = Scheduler()
        var fault = false
        var paused = false
        val db: SQLiteDatabase = TelemetryEventDatabase(RuntimeEnvironment.getApplication(), "rev199-${System.nanoTime()}.db")
            .writableDatabase.also { databases += it }
        lateinit var gate: PlaybackStateCoordinator
        lateinit var controller: PlaybackController
        lateinit var monitor: PlaybackWatchdogMonitor
        lateinit var restore: PauseRestore

        init {
            val directory = temporary.newFolder()
            val media = mediaFixture(directory, byteArrayOf(4, 5, 6))
            val manifest = snapshotOf(listOf(manifestSlot(0, media, 3_600_000L, start, start.plusSeconds(7_200))))
            val recorder = StateChangeRecorder(db, "SYN-device", clock = { start })
            restore = PauseRestore(read = { paused }, execute = { it() }, onChange = { gate.refresh() })
            // Verdrahtung wie MainActivity/PlaybackGateRuntime: Entscheidung startet/stoppt den Controller.
            gate = PlaybackStateCoordinator(
                machine = PlaybackStateMachine(StateMachineConfig(), clock = { mono }),
                readiness = Readiness(),
                content = { ContentAvailability.VALID },
                player = { if (fault) PlayerCondition.ERROR else PlayerCondition.OK },
                recorder = { recorder },
                onDecision = { decision -> if (decision.playbackAllowed) controller.start() else controller.stop() },
                pauseRestore = restore,
            )
            controller = PlaybackController(
                adapterFactory = { observer -> LocalMediaPlayerAdapter(directory, port, observer) },
                clock = MutableClock(start.plusSeconds(5)),
                snapshots = { manifest },
                timer = FakePlaybackTimer(),
                monotonicMillis = { mono },
                playbackPermitted = { gate.decision()?.playbackAllowed ?: false },
            )
            monitor = PlaybackWatchdogMonitor(
                controller = controller,
                state = { gate.stateSnapshot() },
                watchdog = PlaybackWatchdog(ControllerPlaybackRecovery(controller), clock = { mono }),
                schedule = scheduler::schedule,
                onFault = { now -> fault = now; gate.refresh() },
            )
        }

        fun advance(ticks: Int) = repeat(ticks) {
            mono += PlaybackWatchdogMonitor.DEFAULT_INTERVAL_MS
            scheduler.fire()
        }

        fun events(): List<JSONObject> =
            db.rawQuery("select payload_bytes from telemetry_events order by seq", null).use { c ->
                val list = ArrayList<JSONObject>()
                while (c.moveToNext()) list += JSONObject(String(c.getBlob(0), Charsets.UTF_8))
                list
            }
    }

    @Test
    fun repeatedUnknownPositionIsAMissingMeasurementNotAStall() {
        val r = Rig()
        r.gate.start()
        r.monitor.start()
        assertEquals(1, r.port.plays)
        r.port.position = 1_000L
        r.advance(1)
        // Danach meldet der Player dauerhaft "unbekannt" (-1): weit ueber die 60-s-Frist hinaus.
        r.port.position = -1L
        r.advance(30)
        assertEquals("keine Wiederherstellung allein wegen fehlender Messwerte", 0, r.port.releases)
        assertEquals(WatchdogStatus.WAITING, r.monitor.lastOutcome?.status)
        // Bekannter Fortschritt wird wieder normal erkannt.
        r.port.position = 2_000L
        r.advance(1)
        assertEquals(WatchdogStatus.PROGRESS, r.monitor.lastOutcome?.status)
        assertFalse(r.fault)
    }

    @Test
    fun exhaustedBudgetBlocksPlaybackThroughTheGateAndReportsTechnicalFault() {
        val r = Rig()
        r.gate.start()
        r.monitor.start()
        // Player haengt dauerhaft: Versuche bis zur Obergrenze.
        r.advance(7)
        repeat(3) { r.advance(6) }
        r.advance(12)
        assertTrue(r.fault)
        assertEquals(DecisionReason.PLAYER_ERROR, r.gate.decision()!!.reason)
        assertFalse("Freigabe gesperrt", r.gate.decision()!!.playbackAllowed)
        val playsAtFault = r.port.plays
        // Keine weiteren Starts bei gesperrter Freigabe, auch nicht ueber erneute Lifecycle-Starts.
        r.controller.start()
        r.advance(12)
        assertEquals(playsAtFault, r.port.plays)
        // Der technische Zustand ist dauerhaft im Zustandspuffer sichtbar.
        assertTrue(r.events().any { it.optBoolean("technical_fault", false) })
        assertTrue(r.events().last().optBoolean("technical_fault", false))
    }

    @Test
    fun pauseDuringRecoveryKeepsPlaybackStoppedWithoutTechnicalFault() {
        val r = Rig()
        r.gate.start()
        r.monitor.start()
        // Pause trifft genau waehrend der Wiederherstellung ein (zwischen Freigabe und Neustart).
        // Lokaler Pausenwechsel ueber die vorhandene Anbindung (PauseRestore.update, CX-087/CX-100).
        r.port.onRelease = { r.paused = true; r.restore.update(true); r.gate.refresh() }
        r.advance(7)
        assertEquals(1, r.port.releases)
        assertEquals("kein Neustart waehrend der Pause", 1, r.port.plays)
        assertEquals(DecisionReason.PAUSED, r.gate.decision()!!.reason)
        r.advance(12)
        assertEquals(WatchdogStatus.INACTIVE, r.monitor.lastOutcome?.status)
        assertFalse(r.fault)
        assertEquals(1, r.port.plays)
    }
}
