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
 * CX-160: Der Controller meldet jeden gestarteten Spot genau einmal.
 *
 * Player, Timer, Uhr und Senke sind injiziert; es gibt keine Sleeps und keinen
 * Netzaufruf. Geprueft werden vollstaendige und abgebrochene Spots, die
 * monoton gemessene und begrenzte Dauer sowie eine fehlerhafte Senke.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SpotPlayReportingTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var directory: File
    private val records = ArrayList<SpotPlayRecord>()
    private var sinkCalls = 0

    @Before
    fun setUp() {
        directory = temporary.newFolder("media")
        records.clear()
        sinkCalls = 0
    }

    private class LongBox(var value: Long = 0L)

    private class Fixture(
        val controller: PlaybackController,
        val port: RecordingPlayerPort,
        val timer: FakePlaybackTimer,
        val clock: MutableClock,
        val mono: LongBox,
        val states: MutableList<PlaybackUiState>,
    )

    private fun fixture(
        durationMs: Long = 5_000,
        campaignEndSeconds: Long = 600,
        sink: SpotPlaySink = SpotPlaySink { records += it },
    ): Fixture {
        val start = Instant.parse("2026-12-01T10:00:00Z")
        val media = mediaFixture(directory, byteArrayOf(1, 2, 3))
        val manifest = snapshotOf(
            listOf(manifestSlot(0, media, durationMs, start, start.plusSeconds(campaignEndSeconds))),
        )
        val clock = MutableClock(start)
        val timer = FakePlaybackTimer()
        val port = RecordingPlayerPort()
        val mono = LongBox()
        val states = ArrayList<PlaybackUiState>()
        val controller = PlaybackController(
            adapterFactory = { observer -> LocalMediaPlayerAdapter(directory, port, observer) },
            clock = clock,
            snapshots = { manifest },
            timer = timer,
            listener = { states += it },
            monotonicMillis = { mono.value },
            spotPlays = sink,
        )
        return Fixture(controller, port, timer, clock, mono, states)
    }

    private fun Fixture.start(): Fixture {
        controller.start()
        assertEquals(PlaybackUiState.PLAYING, states.last())
        return this
    }

    @Test
    fun playerEndeMeldetVollenSpotMitGemessenerDauer() {
        val f = fixture().start()
        val startedAt = Instant.parse("2026-12-01T10:00:00Z")
        f.mono.value = 3_200L
        f.port.callbacks!!.onEnded(f.port.lastGeneration)

        assertEquals(1, records.size)
        val record = records.single()
        assertTrue(record.completed)
        assertEquals(3_200L, record.playedMs)
        assertEquals(startedAt, record.startedAt)
        assertEquals("SYN-campaign-0", record.campaignId)
        assertTrue(record.mediaId.startsWith("SYN-"))
        // Die Wiedergabe laeuft mit dem naechsten Spot weiter.
        assertEquals(2, f.port.playCalls)
        assertEquals(PlaybackUiState.PLAYING, f.states.last())
    }

    @Test
    fun slotdauerMeldetVollUndGenauEinmalAuchNachStop() {
        val f = fixture().start()
        f.mono.value = 5_000L
        f.timer.fire()

        assertEquals(1, records.size)
        assertTrue(records.single().completed)
        assertEquals(5_000L, records.single().playedMs)

        f.controller.stop()
        assertEquals("kein zweiter Nachweis fuer denselben Spot", 1, records.size)
        assertTrue("0 ms wird nicht gemeldet", records.none { it.playedMs == 0L })
    }

    @Test
    fun abgebrochenerSpotWirdMitGemessenerDauerNichtVollGemeldet() {
        val f = fixture().start()
        f.mono.value = 1_234L
        f.controller.stop()

        assertEquals(1, records.size)
        val record = records.single()
        assertFalse(record.completed)
        assertEquals(1_234L, record.playedMs)
    }

    @Test
    fun playerFehlerMeldetNichtVollUndStoertDieWiedergabeNicht() {
        val f = fixture().start()
        f.mono.value = 800L
        f.port.callbacks!!.onError(f.port.lastGeneration, PlaybackRejection.PLAYER_ERROR)

        assertEquals(1, records.size)
        assertFalse(records.single().completed)
        assertEquals(800L, records.single().playedMs)
        // Der fehlerhafte Spot wird uebersprungen; der naechste Spot startet.
        assertEquals(2, f.port.playCalls)
    }

    @Test
    fun fensterendeVorSlotdauerIstNichtVollstaendig() {
        val f = fixture(durationMs = 5_000, campaignEndSeconds = 3).start()
        f.mono.value = 3_000L
        f.clock.now = Instant.parse("2026-12-01T10:00:03Z")
        f.timer.fire()

        assertEquals(1, records.size)
        assertFalse(records.single().completed)
        assertEquals(3_000L, records.single().playedMs)
    }

    @Test
    fun dauerWirdAufDieSlotdauerBegrenzt() {
        val f = fixture(durationMs = 5_000).start()
        f.mono.value = 9_000L
        f.port.callbacks!!.onEnded(f.port.lastGeneration)

        assertEquals(5_000L, records.single().playedMs)
        assertTrue(records.single().completed)
    }

    @Test
    fun fehlerhafteSenkeAendertWederAuswahlNochZustand() {
        val failing = SpotPlaySink {
            sinkCalls++
            throw IllegalStateException("SYN-senke-defekt")
        }
        val f = fixture(sink = failing).start()
        f.mono.value = 5_000L
        f.timer.fire()

        assertEquals(1, sinkCalls)
        assertEquals(2, f.port.playCalls)
        assertEquals(PlaybackUiState.PLAYING, f.states.last())

        // Auch der naechste Spot wird wieder genau einmal gemeldet und laeuft weiter.
        f.mono.value = 10_000L
        f.port.callbacks!!.onEnded(f.port.lastGeneration)
        assertEquals(2, sinkCalls)
        assertEquals(3, f.port.playCalls)
    }
}
