package gtads.device.info

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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
class InfoCardsTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private val now = Instant.parse("2026-11-24T18:10:00Z")

    private fun json(titles: Int = 4): String {
        val points = (0 until 30).joinToString(",") {
            """{"at":"${Instant.parse("2026-11-24T18:00:00Z").plusSeconds(3600L * it)}","temperature":${it - 5},"condition":"clear"}"""
        }
        val items = (1..titles).joinToString(",") { """{"title":"Meldung Nummer $it"}""" }
        return """{"schema_version":1,"weather":{"city":"Wien","valid_until":"2026-11-25T18:00:00Z","source":"W","points":[$points]},""" +
            """"news":{"valid_until":"2026-11-25T18:00:00Z","source":"N","items":[$items]}}"""
    }

    private fun data() = InfoCards.parse(json().toByteArray())!!

    @Test
    fun weatherSelectsCurrentLaterAndTomorrowInVienna() {
        val card = InfoCards.weatherCard(data().weather, now)!!
        assertEquals(-5, card.now.temperature)
        assertEquals(listOf("22:00", "01:00", "Morgen Mittag"), card.later.map { it.label })
        assertEquals("\uD83C\uDF19", card.later[0].symbol)
        assertEquals(WeatherCondition.CLEAR.symbol, card.later[2].symbol)
        assertEquals(listOf(-2, 1, 12), card.later.map { it.temperature })
    }

    @Test
    fun expiredDataIsHidden() {
        val later = Instant.parse("2026-11-25T18:00:00Z")
        assertNull(InfoCards.weatherCard(data().weather, later))
        assertNull(InfoCards.newsCard(data().news, later, 0))
    }

    @Test
    fun rotationAlternatesAndFallsBack() {
        val rotation = InfoCardRotation({ data() }, { now })
        assertTrue(rotation.next() is InfoCard.Weather)
        assertEquals(3, (rotation.next() as InfoCard.News).titles.size)
        assertTrue(rotation.next() is InfoCard.Weather)
        assertEquals(listOf("Meldung Nummer 4"), (rotation.next() as InfoCard.News).titles)
        assertTrue(InfoCardRotation({ data().copy(weather = null) }, { now }).next() is InfoCard.News)
        assertNull(InfoCardRotation({ null }, { now }).next())
    }

    @Test
    fun malformedBodiesAreRejected() {
        for (bad in listOf("", "[]", "{}", json().replace("clear", "unbekannt"), json().replace("Wien", " "), json(7))) {
            assertNull(bad.take(40), InfoCards.parse(bad.toByteArray()))
        }
        assertNotNull(InfoCards.parse("""{"schema_version":1,"weather":null,"news":null}""".toByteArray()))
    }

    @Test
    fun storeKeepsDataAndIsDueAfterThreeHours() {
        val directory = temporary.newFolder()
        val store = InfoStore(directory)
        val written = System.currentTimeMillis()
        assertTrue(store.isDue(written))
        assertTrue(store.write(json().toByteArray()))
        assertNotNull(store.read())
        assertFalse(store.isDue(System.currentTimeMillis() + 60_000))
        assertTrue(store.isDue(System.currentTimeMillis() + InfoSync.INTERVAL_MS))
        assertTrue(store.isDue(written - 60_000))
    }

    @Test
    fun viewRendersBothCards() {
        val view = InfoCardView(org.robolectric.RuntimeEnvironment.getApplication())
        view.show(InfoCards.weatherCard(data().weather, now)!!)
        assertEquals(3, view.childCount)
        view.show(InfoCards.newsCard(data().news, now, 0)!!)
        assertEquals(5, view.childCount)
    }
}
