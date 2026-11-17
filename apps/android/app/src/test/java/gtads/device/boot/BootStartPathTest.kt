package gtads.device.boot

import android.content.Context
import android.view.View
import gtads.device.MainActivity
import gtads.device.PlaybackGateRuntime
import gtads.device.control.ControlStateAdapter
import gtads.device.state.ContentAvailability
import gtads.device.state.PauseRestore
import gtads.device.state.PlaybackStateCoordinator
import gtads.device.state.PlaybackStateMachine
import gtads.device.state.ReadinessSource
import gtads.device.state.StateMachineConfig
import gtads.device.state.VehicleReadiness
import gtads.device.RegistrationProcess
import gtads.device.control.DeviceBinding
import gtads.device.control.DeviceControlCommand
import gtads.device.control.DeviceControlDatabase
import gtads.device.control.DeviceControlService
import gtads.device.control.DeviceControlStore
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
import java.io.File
import java.time.Instant
import org.junit.After
import org.junit.Assert.assertEquals
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
 * CX-090: Der Boot-Einstieg oeffnet ausschliesslich den normalen Startpfad. Dieser uebernimmt
 * die persistierte Pause (CX-086/CX-100) und prueft die lokale Kampagnenlaufzeit vor jeder
 * Wiedergabe (CX-080/CX-098). Die Activity laeuft echt; Player, Uhr und Timer sind injiziert.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BootStartPathTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var app: Context
    private lateinit var clock: MutableClock
    private lateinit var port: RecordingPlayerPort
    private val start = Instant.parse("2026-12-01T10:00:00Z")
    /** Zuletzt von der Activity erzeugte Freigabe; der Controller prueft sie wie in der App (playbackPermitted). */
    @Volatile
    private var currentGate: PlaybackStateCoordinator? = null
    private val binding = DeviceBinding("00000000-0000-4000-8000-0000000000bb", "SYN-taxi")

    @Before
    fun setUp() {
        app = RuntimeEnvironment.getApplication()
        deleteRegistration()
        app.deleteDatabase(DeviceControlDatabase.DEFAULT_DATABASE_NAME)
        RegistrationProcess.resetForTest()
        val directory = temporary.newFolder("media")
        val media = mediaFixture(directory, byteArrayOf(41, 42, 43))
        val manifest = snapshotOf(listOf(manifestSlot(0, media, 10_000, start, start.plusSeconds(600))))
        clock = MutableClock(start)
        port = RecordingPlayerPort()
        // Freigabe wie PlaybackGateRuntime.createProduction, mit echtem Pausenspeicher (CX-086/CX-100);
        // nur Bereitschaft (Stromanschluss) und Inhaltsquelle sind fuer Robolectric fest.
        PlaybackGateRuntime.installForTest { context, onDecision ->
            lateinit var gate: PlaybackStateCoordinator
            val restore = PauseRestore(
                read = { DeviceControlStore(context).use { ControlStateAdapter(it).current().paused } },
                execute = { work -> work() },
                onChange = { gate.refresh() },
            )
            gate = PlaybackStateCoordinator(
                machine = PlaybackStateMachine(StateMachineConfig(), clock = { 0L }),
                readiness = object : ReadinessSource {
                    override fun current() = VehicleReadiness.ON
                    override fun start(observer: (VehicleReadiness) -> Unit) = Unit
                    override fun stop() = Unit
                },
                content = { ContentAvailability.VALID },
                onDecision = onDecision,
                pauseRestore = restore,
            )
            currentGate = gate
            gate
        }
        PlaybackRuntime.installForTest(
            controllerFactory = { _, listener ->
                PlaybackController(
                    adapterFactory = { observer -> LocalMediaPlayerAdapter(directory, port, observer) },
                    clock = clock,
                    snapshots = { manifest },
                    timer = FakePlaybackTimer(),
                    listener = listener,
                    monotonicMillis = { 0L },
                    playbackPermitted = { currentGate?.decision()?.playbackAllowed ?: false },
                )
            },
            surfaceFactory = { activity -> View(activity) },
        )
    }

    @After
    fun tearDown() {
        PlaybackRuntime.resetForTest()
        PlaybackGateRuntime.resetForTest()
        RegistrationProcess.resetForTest()
        app.deleteDatabase(DeviceControlDatabase.DEFAULT_DATABASE_NAME)
        deleteRegistration()
    }

    private fun deleteRegistration() {
        val file = File(app.noBackupFilesDir, REGISTRATION_FILE_NAME)
        file.delete()
        File(file.path + ".new").delete()
        File(file.path + ".bak").delete()
    }

    private var revision = 0L

    private fun persistPause(paused: Boolean) {
        revision++
        DeviceControlService(DeviceControlStore(app), binding).use { service ->
            service.apply(DeviceControlCommand.SetPause("22222222-2222-4222-8222-%012d".format(revision), binding.deviceId, binding.taxiId, revision, paused))
        }
    }

    /** Startet die Activity genau mit dem Intent des Boot-Einstiegs und liefert die Zahl der Wiedergabestarts. */
    private fun launchFromBoot(): Int {
        val controller = Robolectric.buildActivity(MainActivity::class.java, BootStart.launchIntent(app))
        try {
            controller.setup()
            return port.playCalls
        } finally {
            controller.destroy()
        }
    }

    @Test
    fun startpfadUebernimmtPersistiertePauseUndPrueftDieKampagnenlaufzeit() {
        // Gueltige Laufzeit, keine Pause: der normale Startpfad spielt ab.
        assertEquals(1, launchFromBoot())

        // Persistierte Pause: derselbe Startpfad spielt nicht ab.
        persistPause(true)
        port = RecordingPlayerPort()
        assertEquals("persistierte Pause wird uebernommen", 0, launchFromBoot())

        // Pause aufgehoben, aber Kampagnenlaufzeit abgelaufen: keine Wiedergabe der Kampagne.
        persistPause(false)
        clock.now = start.plusSeconds(3600)
        port = RecordingPlayerPort()
        assertEquals("abgelaufene Laufzeit wird vor der Wiedergabe geprueft", 0, launchFromBoot())
    }
}
