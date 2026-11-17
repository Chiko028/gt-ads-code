package gtads.device.playback

import android.content.Intent
import android.os.Looper
import java.io.File
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * CX-098: zeitliche Neubewertung an der vorhandenen Scheduler-/Playergrenze.
 * Wanduhr und monotone Uhr sind getrennt injiziert; keine Sleeps, kein Netz,
 * kein echter Codec.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlaybackClockTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var directory: File
    private val start = Instant.parse("2026-12-01T10:00:00Z")
    private val end = start.plusSeconds(600)

    @Before
    fun setUp() {
        directory = temporary.newFolder("media")
    }

    private class Rig(
        val controller: PlaybackController,
        val port: RecordingPlayerPort,
        val timer: FakePlaybackTimer,
        val clock: MutableClock,
        val states: MutableList<PlaybackUiState>,
    )

    private fun rig(now: Instant, clockChanges: ClockChangeSource = NoClockChanges): Rig {
        val media = mediaFixture(directory, byteArrayOf(7, 7, 7))
        val manifest = snapshotOf(listOf(manifestSlot(0, media, 3_600_000L, start, end)))
        val clock = MutableClock(now)
        val timer = FakePlaybackTimer()
        val port = RecordingPlayerPort()
        val states = ArrayList<PlaybackUiState>()
        val controller = PlaybackController(
            adapterFactory = { observer -> LocalMediaPlayerAdapter(directory, port, observer) },
            clock = clock,
            snapshots = { manifest },
            timer = timer,
            listener = { states += it },
            monotonicMillis = { 0L },
            clockChanges = clockChanges,
        )
        return Rig(controller, port, timer, clock, states)
    }

    @Test
    fun runningSpotIsStoppedAtExclusiveEndAndNotRescheduled() {
        val r = rig(end.minusMillis(1_500))
        r.controller.start()
        assertEquals(PlaybackUiState.PLAYING, r.states.last())
        assertEquals(1, r.port.prepared.size)

        r.clock.now = end.minusMillis(1)
        r.timer.fire()
        assertEquals(0, r.port.stopCalls)

        // Exakt an der exklusiven Endgrenze.
        r.clock.now = end
        r.timer.fire()
        assertEquals(1, r.port.stopCalls)
        assertEquals(PlaybackUiState.EMPTY, r.states.last())
        assertEquals(1, r.port.prepared.size)
        // Danach hoechstens ein begrenzter Leerlauftermin, der keinen neuen Start bringt.
        if (r.timer.active) {
            r.timer.fire()
        }
        assertEquals(1, r.port.prepared.size)
        assertEquals(1, r.port.stopCalls)
    }

    @Test
    fun forwardWallClockJumpBeyondCampaignEndTriggersImmediateReevaluationWithExactlyOneStop() {
        val context = RuntimeEnvironment.getApplication()
        val r = rig(start.plusSeconds(10), AndroidClockChangeSource(context))
        r.controller.start()
        assertEquals(PlaybackUiState.PLAYING, r.states.last())

        r.clock.now = end.plusSeconds(3_600)
        context.sendBroadcast(Intent(Intent.ACTION_TIME_CHANGED))
        shadowOf(Looper.getMainLooper()).idle()

        // Ohne Timer-Ausloesung sofort neu bewertet: genau ein Stopp, kein Neustart.
        assertEquals(1, r.port.stopCalls)
        assertEquals(PlaybackUiState.EMPTY, r.states.last())
        assertEquals(1, r.port.prepared.size)

        // Nach dem Beenden ist der Empfaenger abgemeldet.
        r.controller.stop()
        val releases = r.port.releaseCalls
        context.sendBroadcast(Intent(Intent.ACTION_TIMEZONE_CHANGED))
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(1, r.port.prepared.size)
        assertEquals(releases, r.port.releaseCalls)
    }

    @Test
    fun clockEventInsideWindowIsReevaluatedWithPlannerRuleWithoutRestart() {
        // REV-195: Ein Uhrereignis innerhalb des bisherigen Fensters bewertet den laufenden Spot mit
        // derselben Planerregel neu: weiterlaufen ohne Neustart, aber ab exakter Endgrenze stoppen.
        val r = rig(start.plusSeconds(30))
        r.controller.start()
        r.clock.now = start.plusSeconds(300)
        r.controller.onClockChanged()
        assertEquals(0, r.port.stopCalls)
        assertEquals(1, r.port.prepared.size)
        assertTrue(PlaybackPlanner(r.clock).isPlayable(manifestSlot(0, mediaFixture(directory, byteArrayOf(7, 7, 7)), 3_600_000L, start, end)))

        r.clock.now = end
        r.controller.onClockChanged()
        assertEquals("Endgrenze ist exklusiv wie im Planer", 1, r.port.stopCalls)
        assertEquals(PlaybackUiState.EMPTY, r.states.last())
    }

    @Test
    fun backwardJumpOrTimezoneChangeNeverStartsOutsideWindowAndAvoidsTightLoop() {
        val r = rig(start.plusSeconds(30))
        r.controller.start()
        assertEquals(1, r.port.prepared.size)

        // Zeitzonenwechsel ohne UTC-Aenderung: Spot laeuft weiter, genau ein neuer Termin.
        val schedulesBefore = r.timer.delays.size
        r.controller.onClockChanged()
        assertEquals(0, r.port.stopCalls)
        assertEquals(schedulesBefore + 1, r.timer.delays.size)
        assertTrue(r.timer.active)

        // Rueckwaertssprung vor den Fensterbeginn: sofortiger Stopp, kein Start ausserhalb.
        r.clock.now = start.minusSeconds(3_600)
        r.controller.onClockChanged()
        assertEquals(1, r.port.stopCalls)
        assertEquals(PlaybackUiState.EMPTY, r.states.last())
        assertEquals(1, r.port.prepared.size)

        // Wiederholte Termine bleiben begrenzt (>= 1 s, <= 60 s) und starten nichts zu frueh.
        repeat(5) {
            assertTrue(r.timer.active)
            val delay = r.timer.delays.last()
            assertTrue("Termin $delay", delay in 1_000L..60_000L)
            r.clock.now = r.clock.now.plusMillis(delay)
            r.timer.fire()
            assertEquals(1, r.port.prepared.size)
        }

        // Erreicht die Wanduhr das Fenster wieder, startet genau ein Spot.
        r.clock.now = start.plusSeconds(1)
        r.controller.onClockChanged()
        assertEquals(2, r.port.prepared.size)
        assertEquals(PlaybackUiState.PLAYING, r.states.last())
    }
}
