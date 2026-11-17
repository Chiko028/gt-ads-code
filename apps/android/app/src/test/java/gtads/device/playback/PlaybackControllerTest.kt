package gtads.device.playback

import java.io.File
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Robolectric-/JVM-Tests des lifecylegebundenen Controllers (CX-082 / R-903).
 * Uhr, Timer und Player-Port sind injiziert; es gibt keine Sleeps und keinen
 * Netzaufruf.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlaybackControllerTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var directory: File

    @Before
    fun setUp() {
        directory = temporary.newFolder("media")
    }

    @Test
    fun spotEndStartsNextSlotAndLoopEndStartsFirstWithoutNetwork() {
        val start = Instant.parse("2026-12-01T10:00:00Z")
        val end = start.plusSeconds(600)
        val first = mediaFixture(directory, byteArrayOf(1, 2, 3))
        val second = mediaFixture(directory, byteArrayOf(4, 5, 6))
        val manifest = snapshotOf(
            listOf(
                manifestSlot(0, first, 5_000, start, end),
                manifestSlot(1, second, 5_000, start, end),
            ),
        )
        val clock = MutableClock(start)
        var mono = 0L
        val timer = FakePlaybackTimer()
        var reads = 0
        val states = ArrayList<PlaybackUiState>()
        val port = RecordingPlayerPort()
        val controller = PlaybackController(
            adapterFactory = { observer -> LocalMediaPlayerAdapter(directory, port, observer) },
            clock = clock,
            snapshots = { reads++; manifest },
            timer = timer,
            listener = { states += it },
            monotonicMillis = { mono },
        )

        controller.start()
        assertEquals(PlaybackUiState.PLAYING, states.last())
        assertEquals(1, port.playCalls)
        assertEquals(listOf(mediaPath(directory, first)), port.prepared)
        assertEquals("UTC-Pruefung mindestens jede Sekunde", 1_000L, timer.delays.last())

        // Die Slotdauer endet, ohne dass der Player ein Ende meldet.
        mono = 5_000L
        timer.fire()
        assertEquals(2, port.playCalls)
        assertEquals(mediaPath(directory, second), port.prepared.last())
        assertEquals(2, reads)

        // Das Ende des letzten Slots springt an den ersten zurueck.
        port.callbacks!!.onEnded(port.lastGeneration)
        assertEquals(3, port.playCalls)
        assertEquals(mediaPath(directory, first), port.prepared.last())
        assertEquals(3, reads)

        assertTrue(
            "nur lokale Dateien aus der privaten Medienablage",
            port.prepared.all { it.isFile && it.parentFile?.canonicalPath == directory.canonicalPath },
        )
    }

    @Test
    fun campaignEndStopsRunningSpotWithoutPlayerCallbackAndSkipsExpired() {
        val start = Instant.parse("2026-12-01T10:00:00Z")
        val first = mediaFixture(directory, byteArrayOf(11))
        val expired = mediaFixture(directory, byteArrayOf(12))
        val next = mediaFixture(directory, byteArrayOf(13))
        val manifest = snapshotOf(
            listOf(
                // Kampagnenende liegt vor der Spotdauer.
                manifestSlot(0, first, 60_000, start.minusSeconds(3_600), start.plusSeconds(30)),
                // Beim Wechsel bereits abgelaufen.
                manifestSlot(1, expired, 60_000, start.minusSeconds(3_600), start.plusSeconds(20)),
                // Beginnt inklusive am Kampagnenende.
                manifestSlot(2, next, 10_000, start.plusSeconds(30), start.plusSeconds(3_600)),
            ),
        )
        val clock = MutableClock(start)
        var mono = 0L
        val timer = FakePlaybackTimer()
        val states = ArrayList<PlaybackUiState>()
        val port = RecordingPlayerPort()
        val controller = PlaybackController(
            adapterFactory = { observer -> LocalMediaPlayerAdapter(directory, port, observer) },
            clock = clock,
            snapshots = { manifest },
            timer = timer,
            listener = { states += it },
            monotonicMillis = { mono },
        )

        controller.start()
        assertEquals(mediaPath(directory, first), port.prepared.single())
        assertEquals(1_000L, timer.delays.first())

        // Uhr springt ans Kampagnenende; kein Player-Endcallback.
        clock.now = start.plusSeconds(30)
        mono = 2_000L
        timer.fire()

        assertEquals(PlaybackUiState.PLAYING, states.last())
        assertEquals(2, port.playCalls)
        assertEquals(mediaPath(directory, next), port.prepared.last())
        assertFalse(
            "abgelaufener Spot darf nicht erneut gewaehlt werden",
            port.prepared.contains(mediaPath(directory, expired)),
        )
        assertTrue("der laufende Spot wurde gestoppt", port.stopCalls >= 1)
    }

    @Test
    fun newSnapshotIsAdoptedAtSlotChangeButInvalidSnapshotDoesNotReplaceIt() {
        val start = Instant.parse("2026-12-01T10:00:00Z")
        val end = start.plusSeconds(600)
        val first = mediaFixture(directory, byteArrayOf(21))
        val later = mediaFixture(directory, byteArrayOf(22))
        val replacement = mediaFixture(directory, byteArrayOf(23))
        val initial = snapshotOf(
            listOf(
                manifestSlot(0, first, 5_000, start, end),
                manifestSlot(1, later, 5_000, start, end),
            ),
        )
        val updated = snapshotOf(listOf(manifestSlot(0, replacement, 5_000, start, end)))
        // Unvollstaendig: der Slot referenziert ein Medium, das nicht in media steht.
        val invalid = snapshotOf(listOf(manifestSlot(0, first, 5_000, start, end)), emptyList())
        val clock = MutableClock(start)
        var mono = 0L
        val timer = FakePlaybackTimer()
        var reads = 0
        val states = ArrayList<PlaybackUiState>()
        val port = RecordingPlayerPort()
        val controller = PlaybackController(
            adapterFactory = { observer -> LocalMediaPlayerAdapter(directory, port, observer) },
            clock = clock,
            snapshots = {
                reads++
                when (reads) {
                    1 -> initial
                    2 -> updated
                    else -> invalid
                }
            },
            timer = timer,
            listener = { states += it },
            monotonicMillis = { mono },
        )

        controller.start()
        assertEquals(mediaPath(directory, first), port.prepared.single())

        // Neuer aktivierter Stand wird am naechsten Slotwechsel uebernommen.
        mono = 5_000L
        timer.fire()
        assertEquals(mediaPath(directory, replacement), port.prepared.last())
        assertEquals(2, reads)

        // Der unvollstaendige Kandidat ersetzt die aktive Auswahl nicht.
        mono = 10_000L
        timer.fire()
        assertEquals(3, port.playCalls)
        assertEquals(mediaPath(directory, replacement), port.prepared.last())
        assertEquals(3, reads)
        assertFalse(states.contains(PlaybackUiState.EMPTY))
    }
}
