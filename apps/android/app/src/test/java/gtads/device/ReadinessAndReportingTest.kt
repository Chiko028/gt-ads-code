package gtads.device

import android.content.Context
import android.view.View
import gtads.device.playback.FakePlaybackTimer
import gtads.device.playback.LocalMediaPlayerAdapter
import gtads.device.playback.MutableClock
import gtads.device.playback.PlaybackController
import gtads.device.playback.PlaybackRuntime
import gtads.device.playback.RecordingPlayerPort
import gtads.device.playback.manifestSlot
import gtads.device.playback.mediaFixture
import gtads.device.playback.snapshotOf
import gtads.device.registration.REGISTRATION_FILE_NAME
import gtads.device.state.ContentAvailability
import gtads.device.state.DecisionReason
import gtads.device.state.GateDecision
import gtads.device.state.PlaybackStateCoordinator
import gtads.device.state.PlaybackStateMachine
import gtads.device.state.ReadinessSource
import gtads.device.state.StateMachineConfig
import gtads.device.state.VehicleReadiness
import gtads.device.telemetry.TechnicalStatusStore
import java.io.File
import java.time.Instant
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * CX-153: Jeder Wiedergabestart bewertet die Bereitschaft neu. Das echte Gate
 * (CX-083-Koordinator) und der echte Startpfad der Activity laufen; nur
 * Bereitschaft, Uhr, Timer und Player sind steuerbare Test-Doubles.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReadinessAndReportingTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var app: Context
    private lateinit var directory: File
    private lateinit var clock: MutableClock
    private lateinit var timer: FakePlaybackTimer
    private lateinit var port: RecordingPlayerPort
    private lateinit var manifest: gtads.device.manifest.ActiveManifest
    private var gate: PlaybackStateCoordinator? = null
    private var onDecision: ((GateDecision) -> Unit)? = null

    /** Steuerbare Bereitschaft ohne Broadcasts, Netz oder echte Wartezeit. */
    private class FakeReadiness(
        var value: VehicleReadiness,
        private val failing: Boolean = false,
    ) : ReadinessSource {
        var currentCalls = 0
            private set
        private var observer: ((VehicleReadiness) -> Unit)? = null

        override fun current(): VehicleReadiness {
            currentCalls++
            if (failing) throw IllegalStateException("Bereitschaft nicht lesbar")
            return value
        }

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

    @Before
    fun setUp() {
        app = RuntimeEnvironment.getApplication()
        directory = temporary.newFolder("media")
        deleteStoredRegistration()
        RegistrationProcess.resetForTest()
        PlaybackGateRuntime.resetForTest()
        PlaybackRuntime.resetForTest()
        TechnicalStatusStore(app).clear(PlaybackGateRuntime.STATUS_COMPONENT)

        val media = mediaFixture(directory, byteArrayOf(71, 72, 73))
        val start = Instant.parse("2026-12-01T10:00:00Z")
        manifest = snapshotOf(
            listOf(manifestSlot(0, media, 10_000, start, start.plusSeconds(600))),
        )
        clock = MutableClock(start)
        timer = FakePlaybackTimer()
        port = RecordingPlayerPort()
        gate = null
        onDecision = null
    }

    @After
    fun tearDown() {
        PlaybackRuntime.resetForTest()
        PlaybackGateRuntime.resetForTest()
        RegistrationProcess.resetForTest()
        TechnicalStatusStore(app).clear(PlaybackGateRuntime.STATUS_COMPONENT)
        deleteStoredRegistration()
    }

    @Test
    fun restartAfterStopReadsCurrentReadinessAndKeepsPlayerLockedWhenOff() {
        val readiness = FakeReadiness(VehicleReadiness.ON)
        installWorkingGate(readiness)
        installController()

        val controller = Robolectric.buildActivity(MainActivity::class.java)
        try {
            controller.setup()
            assertEquals(1, port.playCalls)
            assertTrue(timer.active)
            val readsBeforeStop = readiness.currentCalls

            controller.stop()
            readiness.value = VehicleReadiness.OFF
            controller.start()

            assertTrue(
                "der naechste Start muss die Bereitschaft erneut lesen",
                readiness.currentCalls > readsBeforeStop,
            )
            assertEquals("gesperrte Bereitschaft startet keinen Player", 1, port.playCalls)
            val decision = gate!!.decision()!!
            assertEquals(DecisionReason.VEHICLE_OFF, decision.reason)
            assertFalse(decision.playbackAllowed)
        } finally {
            controller.destroy()
        }
    }

    @Test
    fun missingOrFaultyDecisionBlocksPlaybackAndReportsTechnicalStatus() {
        installMissingGate()
        installController()
        val missing = Robolectric.buildActivity(MainActivity::class.java)
        try {
            missing.setup()
            assertEquals("fehlende Gate-Entscheidung startet nicht", 0, port.playCalls)
            assertEquals(PlaybackGateRuntime.STATUS_DECISION_MISSING, status())
        } finally {
            missing.destroy()
        }

        PlaybackGateRuntime.resetForTest()
        PlaybackRuntime.resetForTest()
        gate = null
        val faulty = FakeReadiness(VehicleReadiness.ON, failing = true)
        installWorkingGate(faulty)
        installController()
        val broken = Robolectric.buildActivity(MainActivity::class.java)
        try {
            broken.setup()
            assertEquals("fehlerhafte Gate-Entscheidung startet nicht", 0, port.playCalls)
            assertEquals(PlaybackGateRuntime.STATUS_EVALUATION_FAILED, status())
        } finally {
            broken.destroy()
        }
    }

    @Test
    fun newDecisionAllowsExactlyOneStartAndLateOldDecisionDoesNot() {
        val readiness = FakeReadiness(VehicleReadiness.ON)
        installWorkingGate(readiness)
        installController()

        val controller = Robolectric.buildActivity(MainActivity::class.java)
        try {
            controller.setup()
            assertEquals(1, port.playCalls)
            val stale = gate!!.decision()!!
            assertTrue(stale.playbackAllowed)

            controller.stop()
            readiness.value = VehicleReadiness.OFF
            controller.start()
            assertEquals("gesperrter Neustart spielt nicht", 1, port.playCalls)

            val beforeLate = port.playCalls
            onDecision!!.invoke(stale)
            assertEquals(
                "verspaetete Entscheidung des vorherigen Startversuchs startet nicht",
                beforeLate,
                port.playCalls,
            )

            readiness.emit(VehicleReadiness.ON)
            assertEquals(
                "neue erfolgreiche Entscheidung erlaubt genau einen Start",
                beforeLate + 1,
                port.playCalls,
            )

            val current = gate!!.decision()!!
            assertTrue(current.playbackAllowed)
            onDecision!!.invoke(current)
            assertEquals(
                "wiederholte Zustellung startet keine zweite Schleife",
                beforeLate + 1,
                port.playCalls,
            )
        } finally {
            controller.destroy()
        }
    }

    private fun installWorkingGate(readiness: ReadinessSource) {
        PlaybackGateRuntime.installForTest { _, callback ->
            onDecision = callback
            val created = PlaybackStateCoordinator(
                machine = PlaybackStateMachine(StateMachineConfig(), clock = { 0L }),
                readiness = readiness,
                content = { ContentAvailability.VALID },
                onDecision = { decision ->
                    callback(decision)
                },
            )
            gate = created
            created
        }
    }

    private fun installMissingGate() {
        PlaybackGateRuntime.installForTest { _, callback ->
            onDecision = callback
            gate = null
            null
        }
    }

    private fun installController() {
        PlaybackRuntime.installForTest(
            controllerFactory = { _, listener ->
                PlaybackController(
                    adapterFactory = { observer ->
                        LocalMediaPlayerAdapter(directory, port, observer)
                    },
                    clock = clock,
                    snapshots = { manifest },
                    timer = timer,
                    listener = listener,
                    monotonicMillis = { 0L },
                    // Dieselbe Produktionsfreigabe wie MainActivity.
                    playbackPermitted = PlaybackGateRuntime.playbackPermitted(app) { gate },
                )
            },
            surfaceFactory = { activity -> View(activity) },
        )
    }

    private fun status(): String? =
        TechnicalStatusStore(app).current(PlaybackGateRuntime.STATUS_COMPONENT)

    private fun deleteStoredRegistration() {
        try {
            val file = File(app.noBackupFilesDir, REGISTRATION_FILE_NAME)
            file.delete()
            File(file.path + ".new").delete()
            File(file.path + ".bak").delete()
        } catch (_: Exception) {
            // Kein gespeicherter Stand vorhanden.
        }
    }
}
