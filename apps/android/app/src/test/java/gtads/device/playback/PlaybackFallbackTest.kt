package gtads.device.playback

import android.view.View
import android.widget.TextView
import gtads.device.MainActivity
import gtads.device.R
import gtads.device.manifest.ActiveManifest
import gtads.device.state.ContentAvailability
import gtads.device.state.PlaybackStateMachine
import gtads.device.state.PlayerCondition
import gtads.device.state.StateInput
import gtads.device.state.VehicleReadiness
import gtads.device.watchdog.ControllerPlaybackRecovery
import gtads.device.watchdog.PlaybackWatchdog
import gtads.device.watchdog.PlaybackWatchdogMonitor
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
import org.robolectric.annotation.Config

/** CX-092 / R-909: lokaler statischer Fallback am produktiven Controller. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlaybackFallbackTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var directory: File
    private val start = Instant.parse("2026-12-01T10:00:00Z")
    private val clock = MutableClock(start.plusSeconds(30))

    @Before
    fun setUp() {
        directory = temporary.newFolder("media")
    }

    @After
    fun tearDown() {
        PlaybackRuntime.resetForTest()
    }

    private fun controller(
        port: RecordingPlayerPort,
        timer: FakePlaybackTimer,
        snapshots: () -> ActiveManifest?,
        permitted: () -> Boolean = { true },
        states: MutableList<PlaybackUiState> = ArrayList(),
    ) = PlaybackController(
        adapterFactory = { observer -> LocalMediaPlayerAdapter(directory, port, observer) },
        clock = clock,
        snapshots = snapshots,
        timer = timer,
        listener = { states += it },
        monotonicMillis = { 0L },
        playbackPermitted = permitted,
    )

    private fun valid(): ActiveManifest {
        val media = mediaFixture(directory, byteArrayOf(4, 2))
        return snapshotOf(listOf(manifestSlot(0, media, 10_000L, start, start.plusSeconds(600))))
    }

    @Test
    fun emptyOrOnlyExpiredPlaylistShowsBuiltInPlaceholderWithoutDownload() {
        val media = mediaFixture(directory, byteArrayOf(1))
        val expired = snapshotOf(listOf(manifestSlot(0, media, 10_000L, start.minusSeconds(7_200), start.minusSeconds(3_600))))
        for (manifest in listOf(snapshotOf(emptyList(), listOf(media)), expired)) {
            val port = RecordingPlayerPort()
            val c = controller(port, FakePlaybackTimer(), { manifest })
            c.start()
            assertTrue(c.isStaticFallback())
            assertEquals(0, port.prepared.size)
            assertEquals(0, port.playCalls)
        }

        // In der Activity erscheint der eingebaute GT-Ads-Platzhalter.
        PlaybackRuntime.installForTest(
            controllerFactory = { _, listener ->
                PlaybackController(
                    adapterFactory = { observer -> LocalMediaPlayerAdapter(directory, RecordingPlayerPort(), observer) },
                    clock = clock,
                    snapshots = { expired },
                    timer = FakePlaybackTimer(),
                    listener = listener,
                    monotonicMillis = { 0L },
                )
            },
            surfaceFactory = { activity -> View(activity) },
        )
        val activity = Robolectric.buildActivity(MainActivity::class.java)
        try {
            activity.setup()
            val placeholder = activity.get().findViewById<TextView>(R.id.playback_empty)
            assertEquals(View.VISIBLE, placeholder.visibility)
            assertEquals("GT-Ads", placeholder.text.toString())
        } finally {
            activity.destroy()
        }
    }

    @Test
    fun pauseAndVehicleOffSuppressFallbackAndResumeReevaluates() {
        val port = RecordingPlayerPort()
        var allowed = false
        val states = ArrayList<PlaybackUiState>()
        val c = controller(port, FakePlaybackTimer(), { snapshotOf(emptyList()) }, { allowed }, states)
        c.start()
        assertFalse(c.isStaticFallback())
        assertFalse(states.contains(PlaybackUiState.EMPTY))

        // Fortsetzen: aktueller Zustand wird neu ausgewertet.
        allowed = true
        c.start()
        assertTrue(c.isStaticFallback())
        assertEquals(PlaybackUiState.EMPTY, states.last())

        // Erneute Pause beendet auch den Fallback.
        allowed = false
        c.stop()
        assertFalse(c.isStaticFallback())
        assertEquals(PlaybackUiState.IDLE, states.last())
    }

    @Test
    fun activatedValidManifestReplacesFallbackAndRejectedManifestKeepsActiveContent() {
        val port = RecordingPlayerPort()
        val timer = FakePlaybackTimer()
        var current: ActiveManifest = snapshotOf(emptyList())
        val states = ArrayList<PlaybackUiState>()
        val c = controller(port, timer, { current }, states = states)
        c.start()
        assertTrue(c.isStaticFallback())

        // Atomarer Wechsel: der naechste begrenzte Termin liest den neuen Stand.
        current = valid()
        timer.fire()
        assertEquals(PlaybackUiState.PLAYING, states.last())
        assertFalse(c.isStaticFallback())
        assertEquals(1, port.playCalls)

        // Ein abgewiesener Kandidat (Medium nicht im Stand) verdraengt den gueltigen Inhalt nicht.
        val foreign = VerifiedMediaFixture.foreign()
        current = snapshotOf(listOf(manifestSlot(0, foreign, 10_000L, start, start.plusSeconds(600))), media = emptyList())
        timer.fire()
        assertFalse(c.isStaticFallback())
        assertEquals(PlaybackUiState.PLAYING, states.last())
    }

    @Test
    fun fallbackCausesNoCampaignPlaybackAndNoWatchdogRestartLoop() {
        val port = RecordingPlayerPort()
        val c = controller(port, FakePlaybackTimer(), { snapshotOf(emptyList()) })
        c.start()
        val tasks = ArrayList<() -> Unit>()
        var mono = 0L
        val monitor = PlaybackWatchdogMonitor(
            controller = c,
            state = {
                PlaybackStateMachine(clock = { mono }).evaluate(
                    StateInput(VehicleReadiness.ON, pauseActive = false, content = ContentAvailability.VALID, player = PlayerCondition.OK),
                )
            },
            watchdog = PlaybackWatchdog(ControllerPlaybackRecovery(c), clock = { mono }),
            schedule = { _, action -> tasks += action; AutoCloseable { tasks.remove(action) } },
        )
        monitor.start()
        repeat(60) {
            mono += PlaybackWatchdogMonitor.DEFAULT_INTERVAL_MS
            tasks.removeAt(0)()
        }
        assertTrue(c.isStaticFallback())
        assertEquals(0, port.prepared.size)
        assertEquals(0, port.playCalls)
        assertEquals(0, port.releaseCalls)
        monitor.stop()
    }
}

/** Medium, das in keinem aktivierten Stand enthalten ist. */
private object VerifiedMediaFixture {
    fun foreign() = gtads.device.manifest.VerifiedMedia.of("SYN-fremd", "f".repeat(64), 10L)!!
}
