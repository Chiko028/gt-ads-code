package gtads.device.info

import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

enum class WeatherCondition(val symbol: String, val label: String) {
    CLEAR("☀️", "Klar"),
    PARTLY("⛅", "Leicht bewölkt"),
    CLOUDY("☁️", "Bewölkt"),
    RAIN("🌧️", "Regen"),
    SNOW("🌨️", "Schnee"),
}

data class WeatherPoint(val at: Instant, val temperature: Int, val condition: WeatherCondition)

data class WeatherInfo(val city: String, val validUntil: Instant, val source: String, val points: List<WeatherPoint>)

data class NewsInfo(val validUntil: Instant, val source: String, val titles: List<String>)

data class InfoData(val weather: WeatherInfo?, val news: NewsInfo?)

data class WeatherRow(val label: String, val temperature: Int, val condition: WeatherCondition, val night: Boolean) {
    /** Nachts kein Sonnensymbol. */
    val symbol: String
        get() = when {
            !night -> condition.symbol
            condition == WeatherCondition.CLEAR -> "\uD83C\uDF19"
            condition == WeatherCondition.PARTLY -> WeatherCondition.CLOUDY.symbol
            else -> condition.symbol
        }
}

/** Fertig ausgewaehlter Inhalt einer Karte; keine Werbung, kein Abspielnachweis. */
sealed interface InfoCard {
    val source: String

    data class Weather(
        val city: String,
        val now: WeatherRow,
        val later: List<WeatherRow>,
        override val source: String,
    ) : InfoCard

    data class News(val titles: List<String>, override val source: String) : InfoCard
}

object InfoCards {
    const val EVERY_SPOTS = 3
    const val SHOW_MS = 10_000L
    private const val TITLES_PER_CARD = 3
    private const val MAX_POINTS = 72
    private const val MAX_TITLES = 6
    private const val MAX_TEXT = 200
    private val ZONE: ZoneId = ZoneId.of("Europe/Vienna")

    /** Strenge Pruefung; null bei jeder Abweichung, damit der letzte gute Stand bleibt. */
    fun parse(body: ByteArray): InfoData? = try {
        val root = JSONTokener(String(body, Charsets.UTF_8)).nextValue() as? JSONObject
        if (root == null || root.optInt("schema_version") != 1) {
            null
        } else {
            InfoData(
                weather = root.optJSONObject("weather")?.let(::weather),
                news = root.optJSONObject("news")?.let(::news),
            )
        }
    } catch (_: Exception) {
        null
    }

    private fun weather(json: JSONObject): WeatherInfo {
        val points = json.getJSONArray("points")
        require(points.length() in 1..MAX_POINTS)
        return WeatherInfo(
            city = text(json, "city"),
            validUntil = Instant.parse(json.getString("valid_until")),
            source = text(json, "source"),
            points = objects(points).map {
                val temperature = it.getInt("temperature")
                require(temperature in -60..60)
                WeatherPoint(
                    Instant.parse(it.getString("at")),
                    temperature,
                    WeatherCondition.valueOf(it.getString("condition").uppercase()),
                )
            }.sortedBy { it.at },
        )
    }

    private fun news(json: JSONObject): NewsInfo {
        val items = json.getJSONArray("items")
        require(items.length() in 1..MAX_TITLES)
        return NewsInfo(
            Instant.parse(json.getString("valid_until")),
            text(json, "source"),
            objects(items).map { text(it, "title") },
        )
    }

    private fun objects(array: JSONArray): List<JSONObject> = List(array.length()) { array.getJSONObject(it) }

    private fun text(json: JSONObject, name: String): String =
        json.getString(name).trim().also { require(it.isNotEmpty() && it.length <= MAX_TEXT) }

    /** Wetterkarte fuer jetzt; ohne passende Stunde oder nach Ablauf null. */
    fun weatherCard(info: WeatherInfo?, now: Instant): InfoCard.Weather? {
        if (info == null || !now.isBefore(info.validUntil)) return null
        val current = nearest(info.points, now) ?: return null
        val later = ArrayList<WeatherRow>()
        for (hours in listOf(3L, 6L)) {
            val at = now.plus(Duration.ofHours(hours))
            nearest(info.points, at)?.let {
                later += row("%02d:00".format(it.at.atZone(ZONE).hour), it)
            }
        }
        val tomorrowNoon = now.atZone(ZONE).toLocalDate().plusDays(1).atTime(12, 0).atZone(ZONE).toInstant()
        nearest(info.points, tomorrowNoon)?.let { later += row("Morgen Mittag", it) }
        return InfoCard.Weather(
            info.city,
            row("Jetzt", current),
            later,
            info.source,
        )
    }

    private fun row(label: String, point: WeatherPoint): WeatherRow {
        val hour = point.at.atZone(ZONE).hour
        return WeatherRow(label, point.temperature, point.condition, night = hour < 7 || hour >= 19)
    }

    private fun nearest(points: List<WeatherPoint>, at: Instant): WeatherPoint? =
        points.minByOrNull { Duration.between(it.at, at).abs() }
            ?.takeIf { Duration.between(it.at, at).abs() <= Duration.ofMinutes(60) }

    /** Wechselt ueber [turn] zwischen den Dreiergruppen. */
    fun newsCard(info: NewsInfo?, now: Instant, turn: Int): InfoCard.News? {
        if (info == null || !now.isBefore(info.validUntil)) return null
        val groups = info.titles.chunked(TITLES_PER_CARD)
        return InfoCard.News(groups[Math.floorMod(turn, groups.size)], info.source)
    }
}

/** Wechselt Wetter und Schlagzeilen ab; fehlt eine Seite, kommt die andere. */
class InfoCardRotation(private val data: () -> InfoData?, private val now: () -> Instant = Instant::now) {
    private var turn = 0

    fun next(): InfoCard? {
        val current = data() ?: return null
        val index = turn++
        val at = now()
        val weather = InfoCards.weatherCard(current.weather, at)
        val news = InfoCards.newsCard(current.news, at, index / 2)
        return if (index % 2 == 0) weather ?: news else news ?: weather
    }
}
