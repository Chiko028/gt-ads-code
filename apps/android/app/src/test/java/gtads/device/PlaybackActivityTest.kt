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
 * Robolectric-Test der Activity-Bindung (CX-082 / R-903). Der Controller wird
 * mit kontrollierter Uhr, kontrolliertem Timer und Player-Port injiziert; die
 * Activity selbst laeuft echt durch onCreate/onStart/onStop.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlaybackActivityTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var app: Context
    private lateinit var directory: File
    private lateinit var clock: MutableClock
    private lateinit var timer: FakePlaybackTimer
    private lateinit var port: RecordingPlayerPort
    private lateinit var manifest: gtads.device.manifest.ActiveManifest
    private var mono = 0L
    private var snapshotReads = 0
    private var adapterCreations = 0

    @Before
    fun setUp() {
        app = RuntimeEnvironment.getApplication()
        directory = temporary.newFolder("media")
        deleteStoredRegistration()
        RegistrationProcess.resetForTest()

        val media = mediaFixture(directory, byteArrayOf(31, 32, 33))
        val start = Instant.parse("2026-12-01T10:00:00Z")
        manifest = snapshotOf(listOf(manifestSlot(0, media, 10_000, start, start.plusSeconds(600))))
        clock = MutableClock(start)
        timer = FakePlaybackTimer()
        port = RecordingPlayerPort()
        snapshotReads = 0
        adapterCreations = 0

        PlaybackRuntime.installForTest(
            controllerFactory = { _, listener ->
                PlaybackController(
                    adapterFactory = { observer ->
                        adapterCreations++
                        LocalMediaPlayerAdapter(directory, port, observer)
                    },
                    clock = clock,
                    snapshots = { snapshotReads++; manifest },
                    timer = timer,
                    listener = listener,
                    monotonicMillis = { mono },
                )
            },
            surfaceFactory = { activity -> View(activity) },
        )
    }

    @After
    fun tearDown() {
        PlaybackRuntime.resetForTest()
        RegistrationProcess.resetForTest()
        deleteStoredRegistration()
    }

    @Test
    fun stopReleasesPlayerAndTimerAndRestartReadsCurrentSnapshotWithOneLoop() {
        val controller = Robolectric.buildActivity(MainActivity::class.java)
        try {
            controller.setup()
            assertEquals(1, snapshotReads)
            assertEquals(1, port.playCalls)
            assertEquals(0, port.releaseCalls)
            assertTrue("Timer muss waehrend der Wiedergabe aktiv sein", timer.active)

            controller.stop()
            assertEquals("Activity-Stopp gibt den Player frei", 1, port.releaseCalls)
            assertFalse("Activity-Stopp beendet den Timer", timer.active)

            controller.start()
            assertEquals("erneuter Start liest den aktuellen Snapshot", 2, snapshotReads)
            assertEquals(2, port.playCalls)
            assertEquals(2, adapterCreations)

            // Wiederholtes onStart erzeugt keine zweite Wiedergabeschleife.
            controller.get().startPlayback()
            assertEquals(2, snapshotReads)
            assertEquals(2, port.playCalls)
            assertEquals(2, adapterCreations)
            assertEquals(1, port.releaseCalls)
        } finally {
            controller.destroy()
        }
    }

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
