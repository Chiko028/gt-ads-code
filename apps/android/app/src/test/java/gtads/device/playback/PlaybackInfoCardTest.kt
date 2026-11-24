package gtads.device.playback

import gtads.device.info.InfoCard
import gtads.device.info.InfoCards
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlaybackInfoCardTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private val card = InfoCard.News(listOf("Meldung"), "Quelle")
    private val states = ArrayList<PlaybackUiState>()
    private val records = ArrayList<SpotPlayRecord>()
    private val timer = FakePlaybackTimer()
    private val port = RecordingPlayerPort()
    private var mono = 0L

    private fun controller(cards: () -> InfoCard?): PlaybackController {
        val start = Instant.parse("2026-12-01T10:00:00Z")
        val directory = temporary.newFolder()
        val media = mediaFixture(directory, byteArrayOf(1, 2))
        val manifest = snapshotOf(listOf(manifestSlot(0, media, 5_000, start, start.plusSeconds(600))))
        return PlaybackController(
            adapterFactory = { observer -> LocalMediaPlayerAdapter(directory, port, observer) },
            clock = MutableClock(start),
            snapshots = { manifest },
            timer = timer,
            listener = { states += it },
            monotonicMillis = { mono },
            spotPlays = SpotPlaySink { records += it },
            infoCards = cards,
        )
    }

    private fun finishSpot() {
        mono += 5_000L
        port.callbacks!!.onEnded(port.lastGeneration)
    }

    @Test
    fun cardFollowsThreeCompletedSpotsThenPlaybackContinues() {
        val c = controller { card }
        c.start()
        finishSpot()
        finishSpot()
        assertFalse(states.contains(PlaybackUiState.INFO))
        finishSpot()
        assertEquals(PlaybackUiState.INFO, states.last())
        assertEquals(card, c.currentInfoCard)
        assertEquals(InfoCards.SHOW_MS, timer.delays.last())
        assertTrue("Watchdog haelt die Karte nicht fuer einen Haenger", c.isStaticFallback())
        assertEquals("Karte ist kein Abspielnachweis", 3, records.size)
        val plays = port.playCalls
        timer.fire()
        assertEquals(PlaybackUiState.PLAYING, states.last())
        assertEquals(plays + 1, port.playCalls)
        assertNull(c.currentInfoCard)
        assertEquals(3, records.size)
    }

    @Test
    fun stopDuringCardClearsIt() {
        val c = controller { card }
        c.start()
        repeat(3) { finishSpot() }
        c.stop()
        assertEquals(PlaybackUiState.IDLE, states.last())
        assertNull(c.currentInfoCard)
        assertEquals(3, records.size)
    }

    @Test
    fun missingOrFailingCardNeverInterruptsPlayback() {
        for (cards in listOf<() -> InfoCard?>({ null }, { error("defekt") })) {
            val c = controller(cards)
            c.start()
            repeat(4) { finishSpot() }
            assertEquals(PlaybackUiState.PLAYING, states.last())
            c.stop()
        }
        assertFalse(states.contains(PlaybackUiState.INFO))
    }
}
