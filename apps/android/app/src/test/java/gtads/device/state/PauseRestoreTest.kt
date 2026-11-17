package gtads.device.state

import gtads.device.control.ControlStateAdapter
import gtads.device.control.DeviceBinding
import gtads.device.control.DeviceControlCommand
import gtads.device.control.DeviceControlService
import gtads.device.control.DeviceControlStore
import gtads.device.playback.FakePlaybackTimer
import gtads.device.playback.LocalMediaPlayerAdapter
import gtads.device.playback.MutableClock
import gtads.device.playback.PlaybackController
import gtads.device.playback.RecordingPlayerPort
import gtads.device.playback.manifestSlot
import gtads.device.playback.mediaFixture
import gtads.device.playback.snapshotOf
import java.io.File
import java.time.Instant
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** CX-100: Initialisierungsbarriere mit echtem Pausenspeicher und Player-Testadapter. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PauseRestoreTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private val context = RuntimeEnvironment.getApplication()
    private val dbName = "cx100-${System.nanoTime()}.db"
    private val binding = DeviceBinding("00000000-0000-4000-8000-0000000000aa", "SYN-taxi")
    private val start = Instant.parse("2026-12-01T10:00:00Z")

    @After
    fun tearDown() {
        context.deleteDatabase(dbName)
    }

    private class Readiness : ReadinessSource {
        override fun current() = VehicleReadiness.ON
        override fun start(observer: (VehicleReadiness) -> Unit) = Unit
        override fun stop() = Unit
    }

    /** Persistiert eine angewandte Fernpause wie CX-086/CX-087 und liefert die Zahl ausstehender Quittungen. */
    private fun persistPause(paused: Boolean, revision: Long = 1): Int =
        DeviceControlService(DeviceControlStore(context, dbName), binding).use { service ->
            service.apply(DeviceControlCommand.SetPause("11111111-1111-4111-8111-%012d".format(revision), binding.deviceId, binding.taxiId, revision, paused))
            service.pendingAcknowledgements().size
        }

    private fun pendingAcks(): Int =
        DeviceControlService(DeviceControlStore(context, dbName), binding).use { it.pendingAcknowledgements().size }

    private fun storedPaused(): Boolean =
        DeviceControlStore(context, dbName).use { ControlStateAdapter(it).current().paused }

    private class Rig(val gate: PlaybackStateCoordinator, val port: RecordingPlayerPort, val runLoad: () -> Unit)

    /** Verdrahtung wie MainActivity: Gate-Entscheidung startet den vorhandenen Controller. */
    private fun rig(read: () -> Boolean): Rig {
        val directory: File = temporary.newFolder()
        val media = mediaFixture(directory, byteArrayOf(5, 5, 5))
        val manifest = snapshotOf(listOf(manifestSlot(0, media, 60_000L, start, start.plusSeconds(3_600))))
        val port = RecordingPlayerPort()
        val pendingWork = ArrayList<() -> Unit>()
        lateinit var gate: PlaybackStateCoordinator
        val restore = PauseRestore(read = read, execute = { pendingWork += it }, onChange = { gate.refresh() })
        lateinit var controller: PlaybackController
        gate = PlaybackStateCoordinator(
            machine = PlaybackStateMachine(StateMachineConfig(), clock = { 0L }),
            readiness = Readiness(),
            content = { ContentAvailability.VALID },
            onDecision = { decision -> if (decision.playbackAllowed) controller.start() else controller.stop() },
            pauseRestore = restore,
        )
        controller = PlaybackController(
            adapterFactory = { observer -> LocalMediaPlayerAdapter(directory, port, observer) },
            clock = MutableClock(start.plusSeconds(10)),
            snapshots = { manifest },
            timer = FakePlaybackTimer(),
            monotonicMillis = { 0L },
            playbackPermitted = { gate.decision()?.playbackAllowed ?: false },
        )
        return Rig(gate, port) {
            val work = pendingWork.toList()
            pendingWork.clear()
            work.forEach { it() }
        }
    }

    @Test
    fun restartWithPersistedPauseAndDelayedLoadNeverStartsPlayer() {
        val acksBefore = persistPause(true)
        val r = rig { storedPaused() }
        r.gate.start()
        assertTrue(r.gate.decision()!!.restorePending)
        assertEquals(0, r.port.playCalls)

        r.runLoad()
        assertEquals(false, r.gate.decision()!!.restorePending)
        assertEquals(false, r.gate.decision()!!.playbackAllowed)
        assertEquals(DecisionReason.PAUSED, r.gate.decision()!!.reason)
        r.gate.refresh()
        assertEquals(0, r.port.playCalls)
        assertEquals(acksBefore, pendingAcks())
    }

    @Test
    fun withoutPauseThePlayerStartsExactlyOnceAfterRestore() {
        // REV-200: echter Pausenspeicher mit gespeichertem inaktivem Zustand statt konstantem Boolean.
        val acksBefore = persistPause(false)
        val r = rig { storedPaused() }
        r.gate.start()
        assertEquals(0, r.port.playCalls)
        r.runLoad()
        assertEquals(1, r.port.playCalls)
        // Wiederholte Lifecycle-Rueckrufe: kein zweiter Start.
        r.gate.start()
        r.gate.refresh()
        r.gate.stop()
        r.gate.start()
        r.runLoad()
        assertEquals(1, r.port.playCalls)
        assertEquals(acksBefore, pendingAcks())
    }

    @Test
    fun restoredPauseFollowsLaterLiftAndRenewedPauseWithoutAcknowledging() {
        // REV-200: Eine beim Start aktive Pause darf nicht eingefroren bleiben.
        persistPause(true)
        val r = rig { storedPaused() }
        r.gate.start()
        r.runLoad()
        assertEquals(false, r.gate.decision()!!.playbackAllowed)
        assertEquals(0, r.port.playCalls)

        val acksBefore = persistPause(false, revision = 2)
        r.gate.refresh()
        r.runLoad()
        assertEquals("aufgehobene Pause gibt die Wiedergabe frei", true, r.gate.decision()!!.playbackAllowed)
        assertEquals(1, r.port.playCalls)

        persistPause(true, revision = 3)
        r.gate.periodicTick()
        r.runLoad()
        assertEquals("erneute Pause wird auch ueber den periodischen Ausloeser uebernommen", false, r.gate.decision()!!.playbackAllowed)
        assertEquals(DecisionReason.PAUSED, r.gate.decision()!!.reason)
        // Das Nachlesen erzeugt selbst keine zusaetzlichen Quittungen.
        assertEquals(acksBefore + 1, pendingAcks())
    }

    @Test
    fun loadFailureKeepsPlaybackLockedAndRetryAppliesStoredStateWithoutAcknowledging() {
        val acksBefore = persistPause(true)
        var fail = true
        val r = rig { if (fail) throw IllegalStateException("SYN-Lesefehler") else storedPaused() }
        r.gate.start()
        r.runLoad()
        assertTrue(r.gate.decision()!!.restorePending)
        assertEquals("pausenspeicher_lesefehler", r.gate.storageError)
        assertEquals(0, r.port.playCalls)
        // Keine Dauerschleife: ohne Ausloeser kein neuer Ladeversuch.
        r.runLoad()
        assertTrue(r.gate.decision()!!.restorePending)

        // Kontrollierte Wiederholung ueber den naechsten Lifecycle-Start.
        fail = false
        r.gate.stop()
        r.gate.start()
        r.runLoad()
        assertEquals(false, r.gate.decision()!!.restorePending)
        assertEquals(false, r.gate.decision()!!.playbackAllowed)
        assertEquals(0, r.port.playCalls)
        assertEquals(acksBefore, pendingAcks())
    }
}
