package gtads.device.telemetry

import android.os.Looper
import gtads.device.auth.DeviceAuthClient
import gtads.device.auth.DeviceAuthResult
import gtads.device.registration.normalizeServerBaseUrl
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL

/** Ein gepuffertes Ereignis: unveraenderte ID und unveraenderte JSON-Nutzdaten aus dem Puffer. */
class OutgoingEvent(val eventId: String, payloadBytes: ByteArray) {
    private val bytes = payloadBytes.copyOf()

    fun payloadBytes(): ByteArray = bytes.copyOf()
}

/** Ergebnis eines einzelnen Uebertragungsversuchs (CX-093 / R-910). */
sealed interface EventTransportResult {
    /** Nur die vom Server ausdruecklich bestaetigten IDs (accepted_event_ids, CX-046). */
    data class Accepted(val acceptedEventIds: Set<String>) : EventTransportResult

    /** Voruebergehend: spaeter erneut versuchen; optional vom Server verlangte Wartezeit in Sekunden. */
    data class Retryable(val retryAfterSeconds: Long?) : EventTransportResult

    /** Geraeteauthentifizierung abgelehnt (401/403) oder kein Zugangsnachweis vorhanden. */
    data object AuthenticationRequired : EventTransportResult

    /** Dauerhaft abgelehnte Anfrage; derselbe Batch wird nicht erfolgreich werden. */
    data class Rejected(val status: Int) : EventTransportResult

    /** Lokal ungueltiger Aufruf (leerer/zu grosser Batch, beschaedigte Pufferdaten, Hauptthread). */
    data object InvalidInput : EventTransportResult
}

/**
 * Begrenzter HTTPS-Transport fuer POST /v1/device/events (CX-046) mit der vorhandenen
 * Geraeteauthentifizierung aus CX-074 (DeviceAuthClient, Bearer-Nachweis).
 *
 * Der Adapter loescht keine Pufferdaten, wiederholt nicht selbststaendig und startet
 * keinen Hintergrundjob; ueber bestaetigte Ereignisse entscheidet ausschliesslich die
 * Serverantwort. Zugangsnachweise und Nutzdaten erscheinen in keinem Ergebnis.
 */
class DeviceEventTransport(
    private val baseUrl: String,
    private val obtainToken: () -> DeviceAuthResult,
    private val openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
    private val onMainThread: () -> Boolean = { Looper.myLooper() == Looper.getMainLooper() },
) {
    /** Produktive Verdrahtung: Zugangsnachweis ueber die Geraeteanmeldung aus CX-074. */
    constructor(
        baseUrl: String,
        auth: DeviceAuthClient,
        openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
    ) : this(baseUrl, auth::obtainToken, openConnection)

    fun send(events: List<OutgoingEvent>): EventTransportResult {
        if (onMainThread()) return EventTransportResult.InvalidInput
        if (events.isEmpty() || events.size > MAX_BATCH_EVENTS) return EventTransportResult.InvalidInput
        val body = batchBody(events) ?: return EventTransportResult.InvalidInput
        val target = targetUrl() ?: return EventTransportResult.InvalidInput
        val token = when (val auth = obtainToken()) {
            is DeviceAuthResult.Token -> auth.accessToken
            DeviceAuthResult.AuthenticationRequired -> return EventTransportResult.AuthenticationRequired
            DeviceAuthResult.Unavailable -> return EventTransportResult.Retryable(null)
            DeviceAuthResult.InvalidInput -> return EventTransportResult.InvalidInput
        }
        val sentIds = events.map { it.eventId }.toSet()

        var connection: HttpURLConnection? = null
        var responseStream: InputStream? = null
        try {
            val opened = openConnection(target)
            connection = opened
            opened.requestMethod = "POST"
            opened.doOutput = true
            // Keine automatische Weiterleitung: der Bearer-Nachweis darf kein anderes Ziel erreichen.
            opened.instanceFollowRedirects = false
            opened.connectTimeout = CONNECT_TIMEOUT_MS
            opened.readTimeout = READ_TIMEOUT_MS
            opened.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
            opened.setRequestProperty("X-GT-Ads-Api-Version", API_VERSION)
            opened.setRequestProperty("Authorization", "Bearer $token")
            // Feste Laenge: der HTTP-Stack darf den Request nicht still wiederholen.
            opened.setFixedLengthStreamingMode(body.size)
            opened.outputStream.use { it.write(body) }

            val status = opened.responseCode
            if (status == 200) {
                responseStream = opened.inputStream
                val bytes = readBounded(responseStream) ?: return EventTransportResult.Retryable(null)
                val accepted = acceptedIds(bytes, sentIds) ?: return EventTransportResult.Retryable(null)
                return EventTransportResult.Accepted(accepted)
            }
            return classify(status, opened.getHeaderField("Retry-After"))
        } catch (_: SocketTimeoutException) {
            return EventTransportResult.Retryable(null)
        } catch (_: IOException) {
            return EventTransportResult.Retryable(null)
        } finally {
            try {
                responseStream?.close()
            } catch (_: IOException) {
                // Schliessen darf das Ergebnis nicht veraendern.
            }
            connection?.disconnect()
        }
    }

    private fun classify(status: Int, retryAfter: String?): EventTransportResult = when {
        status == 401 || status == 403 -> EventTransportResult.AuthenticationRequired
        status == 408 || status == 429 || status in 500..599 -> EventTransportResult.Retryable(retryAfterSeconds(retryAfter))
        // Weiterleitungen, sonstige 2xx und alle uebrigen Codes gelten nie als Annahme.
        else -> EventTransportResult.Rejected(status)
    }

    /** {"events":[...]} aus den unveraenderten Nutzdaten; jede Nutzlast muss ein Objekt mit passender event_id sein. */
    private fun batchBody(events: List<OutgoingEvent>): ByteArray? {
        val ids = HashSet<String>()
        val out = ByteArrayOutputStream()
        out.write(BATCH_PREFIX)
        events.forEachIndexed { index, event ->
            if (event.eventId.isEmpty() || !ids.add(event.eventId)) return null
            val payload = event.payloadBytes()
            val parsed = try {
                JSONTokener(String(payload, Charsets.UTF_8)).nextValue()
            } catch (_: JSONException) {
                return null
            }
            if (parsed !is JSONObject || parsed.opt("event_id") != event.eventId) return null
            if (index > 0) out.write(','.code)
            out.write(payload)
        }
        out.write(BATCH_SUFFIX)
        return out.toByteArray()
    }

    /** accepted_event_ids muss ein Array aus Strings sein, die alle in diesem Batch gesendet wurden. */
    private fun acceptedIds(bytes: ByteArray, sentIds: Set<String>): Set<String>? {
        val root = try {
            JSONTokener(String(bytes, Charsets.UTF_8)).nextValue()
        } catch (_: JSONException) {
            return null
        }
        if (root !is JSONObject) return null
        val array = root.opt("accepted_event_ids") as? JSONArray ?: return null
        val accepted = LinkedHashSet<String>()
        for (i in 0 until array.length()) {
            val id = array.opt(i) as? String ?: return null
            if (id !in sentIds) return null
            accepted.add(id)
        }
        return accepted
    }

    private fun retryAfterSeconds(raw: String?): Long? {
        val value = raw?.trim()?.toLongOrNull() ?: return null
        return if (value in 0..MAX_RETRY_AFTER_SECONDS) value else null
    }

    /** Liest hoechstens MAX_RESPONSE_BYTES + 1 Bytes; mehr ergibt keinen Teilbody. */
    private fun readBounded(stream: InputStream?): ByteArray? {
        if (stream == null) return ByteArray(0)
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(READ_BUFFER_BYTES)
        var total = 0
        while (true) {
            val read = stream.read(buffer, 0, minOf(buffer.size, MAX_RESPONSE_BYTES + 1 - total))
            if (read < 0) return output.toByteArray()
            total += read
            if (total > MAX_RESPONSE_BYTES) return null
            output.write(buffer, 0, read)
        }
    }

    private fun targetUrl(): URL? {
        val normalized = normalizeServerBaseUrl(baseUrl) ?: return null
        val base = try {
            URL(normalized)
        } catch (_: Exception) {
            return null
        }
        return try {
            URL(base.protocol, base.host, base.port, (base.path ?: "") + EVENTS_PATH)
        } catch (_: Exception) {
            null
        }
    }

    companion object {
        /** Serverseitige Batchgrenze (CX-046: 1 bis 100 Ereignisse). */
        const val MAX_BATCH_EVENTS = 100
        const val CONNECT_TIMEOUT_MS = 10_000
        const val READ_TIMEOUT_MS = 15_000
        const val MAX_RESPONSE_BYTES = 262_144
        const val MAX_RETRY_AFTER_SECONDS = 86_400L
        private const val READ_BUFFER_BYTES = 8_192
        private const val API_VERSION = "1"
        private const val EVENTS_PATH = "/v1/device/events"
        private val BATCH_PREFIX = "{\"events\":[".toByteArray(Charsets.UTF_8)
        private val BATCH_SUFFIX = "]}".toByteArray(Charsets.UTF_8)
    }
}
