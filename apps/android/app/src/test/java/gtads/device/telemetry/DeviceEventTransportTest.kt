package gtads.device.telemetry

import gtads.device.auth.DeviceAuthResult
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL

/** Aufzeichnende Verbindung ohne Netzwerk. */
private class FakeEventConnection(url: URL) : HttpURLConnection(url) {
    var status = 200
    var responseBody = ByteArray(0)
    var headers: Map<String, String> = emptyMap()
    var timeout = false
    val sent = ByteArrayOutputStream()
    val requestHeaders = HashMap<String, String>()
    var fixedLength: Int? = null
    var disconnectedFlag = false

    override fun connect() = Unit
    override fun disconnect() { disconnectedFlag = true }
    override fun usingProxy() = false
    override fun setFixedLengthStreamingMode(contentLength: Int) { fixedLength = contentLength }
    override fun setRequestProperty(key: String, value: String) { requestHeaders[key] = value }
    override fun getOutputStream(): OutputStream = sent
    override fun getResponseCode(): Int {
        if (timeout) throw SocketTimeoutException("synthetisch")
        return status
    }
    override fun getHeaderField(name: String): String? = headers[name]
    override fun getInputStream(): InputStream = ByteArrayInputStream(responseBody)
    override fun getErrorStream(): InputStream = ByteArrayInputStream(responseBody)
}

private class BrokenStreamConnection(url: URL) : HttpURLConnection(url) {
    override fun connect() = Unit
    override fun disconnect() = Unit
    override fun usingProxy() = false
    override fun getOutputStream(): OutputStream = throw IOException("synthetisch")
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DeviceEventTransportTest {
    private val token = "SYN-TOKEN-geheim-123"
    private val ids = listOf(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
    )

    private fun event(id: String, occurredAt: String = "2026-01-01T10:00:00.000Z"): OutgoingEvent {
        val json = """{"event_id":"$id","occurred_at":"$occurredAt","vehicle_ready":true,"paused":false,""" +
            """"playback":"playing","technical_fault":null}"""
        return OutgoingEvent(id, json.toByteArray(Charsets.UTF_8))
    }

    private fun transport(
        fake: HttpURLConnection,
        authResult: DeviceAuthResult = DeviceAuthResult.Token(token),
    ): Pair<DeviceEventTransport, MutableList<URL>> {
        val opened = mutableListOf<URL>()
        val t = DeviceEventTransport(
            baseUrl = "https://gtads.example.invalid/basis",
            obtainToken = { authResult },
            openConnection = { url -> opened.add(url); fake },
            onMainThread = { false },
        )
        return t to opened
    }

    @Test
    fun sendetCx046BatchMitGeraeteauthentifizierungUndUnveraendertenEreignissen() {
        val fake = FakeEventConnection(URL("https://unused.invalid"))
        fake.responseBody = """{"accepted_event_ids":["${ids[0]}","${ids[1]}"],"inserted_event_ids":["${ids[0]}"],"duplicate_event_ids":["${ids[1]}"]}"""
            .toByteArray()
        val events = listOf(event(ids[0], "2026-01-01T10:00:00.123Z"), event(ids[1]))
        val (t, opened) = transport(fake)

        val result = t.send(events)

        assertEquals(EventTransportResult.Accepted(ids.toSet()), result)
        assertEquals("https://gtads.example.invalid/basis/v1/device/events", opened.single().toString())
        assertEquals("POST", fake.requestMethod)
        assertFalse(fake.instanceFollowRedirects)
        assertEquals("Bearer $token", fake.requestHeaders["Authorization"])
        assertEquals("1", fake.requestHeaders["X-GT-Ads-Api-Version"])
        val body = fake.sent.toByteArray()
        assertEquals(body.size, fake.fixedLength)
        val sentEvents = JSONObject(String(body, Charsets.UTF_8)).getJSONArray("events")
        assertEquals(2, sentEvents.length())
        // IDs, Zeitstempel und Nutzdaten byte-genau aus dem Puffer.
        val expected = "{\"events\":[" + events.joinToString(",") { String(it.payloadBytes(), Charsets.UTF_8) } + "]}"
        assertEquals(expected, String(body, Charsets.UTF_8))
        assertTrue(fake.disconnectedFlag)

        // Nur ausdruecklich bestaetigte IDs gelten als angenommen.
        val partial = FakeEventConnection(URL("https://unused.invalid"))
        partial.responseBody = """{"accepted_event_ids":["${ids[1]}"]}""".toByteArray()
        assertEquals(EventTransportResult.Accepted(setOf(ids[1])), transport(partial).first.send(events))
    }

    @Test
    fun timeout429Und503SindWiederholbarUndVeraendernDenPufferNicht() {
        val events = listOf(event(ids[0]))
        val before = events.map { it.payloadBytes().toList() }

        val timeout = FakeEventConnection(URL("https://unused.invalid")).apply { timeout = true }
        assertEquals(EventTransportResult.Retryable(null), transport(timeout).first.send(events))

        val limited = FakeEventConnection(URL("https://unused.invalid")).apply { status = 429; headers = mapOf("Retry-After" to "30") }
        assertEquals(EventTransportResult.Retryable(30), transport(limited).first.send(events))

        val unavailable = FakeEventConnection(URL("https://unused.invalid")).apply { status = 503 }
        assertEquals(EventTransportResult.Retryable(null), transport(unavailable).first.send(events))

        val absurd = FakeEventConnection(URL("https://unused.invalid")).apply { status = 503; headers = mapOf("Retry-After" to "-5") }
        assertEquals(EventTransportResult.Retryable(null), transport(absurd).first.send(events))

        val broken = BrokenStreamConnection(URL("https://unused.invalid"))
        assertEquals(EventTransportResult.Retryable(null), transport(broken).first.send(events))

        // Der Adapter haelt keine Referenz auf veraenderbare Puffer-Bytes und aendert sie nicht.
        assertEquals(before, events.map { it.payloadBytes().toList() })
    }

    @Test
    fun authFehlerWeiterleitungenUndBeschaedigteAntwortenSindNieEineAnnahme() {
        val events = listOf(event(ids[0]), event(ids[1]))
        val cases = listOf(
            Triple(401, "", EventTransportResult.AuthenticationRequired),
            Triple(403, "", EventTransportResult.AuthenticationRequired),
            Triple(302, "", EventTransportResult.Rejected(302)),
            Triple(307, "", EventTransportResult.Rejected(307)),
            Triple(400, """{"error":"invalid_request"}""", EventTransportResult.Rejected(400)),
            Triple(409, "", EventTransportResult.Rejected(409)),
            Triple(201, """{"accepted_event_ids":["${ids[0]}"]}""", EventTransportResult.Rejected(201)),
            Triple(200, "kein json", EventTransportResult.Retryable(null)),
            Triple(200, "[]", EventTransportResult.Retryable(null)),
            Triple(200, """{"accepted_event_ids":"${ids[0]}"}""", EventTransportResult.Retryable(null)),
            Triple(200, """{"accepted_event_ids":[1]}""", EventTransportResult.Retryable(null)),
            Triple(200, """{"accepted_event_ids":["99999999-9999-4999-8999-999999999999"]}""", EventTransportResult.Retryable(null)),
        )
        for ((status, body, expected) in cases) {
            val fake = FakeEventConnection(URL("https://unused.invalid"))
            fake.status = status
            fake.responseBody = body.toByteArray()
            val result = transport(fake).first.send(events)
            assertEquals("Status $status / $body", expected, result)
            assertFalse(result is EventTransportResult.Accepted)
            // Ergebnisse enthalten weder Zugangsnachweis noch Ereignisnutzlast.
            assertFalse(result.toString().contains(token))
            assertFalse(result.toString().contains("playing"))
        }

        // Zu grosse Erfolgsantwort ist keine Annahme.
        val huge = FakeEventConnection(URL("https://unused.invalid"))
        huge.responseBody = ByteArray(DeviceEventTransport.MAX_RESPONSE_BYTES + 1) { 'a'.code.toByte() }
        assertEquals(EventTransportResult.Retryable(null), transport(huge).first.send(events))

        // Ohne gueltigen Zugangsnachweis (CX-074) wird nichts gesendet.
        for ((auth, expected) in listOf(
            DeviceAuthResult.AuthenticationRequired to EventTransportResult.AuthenticationRequired,
            DeviceAuthResult.Unavailable to EventTransportResult.Retryable(null),
            DeviceAuthResult.InvalidInput to EventTransportResult.InvalidInput,
        )) {
            val noToken = FakeEventConnection(URL("https://unused.invalid"))
            val (t, opened) = transport(noToken, authResult = auth)
            assertEquals(expected, t.send(events))
            assertTrue(opened.isEmpty())
        }

        // Lokal ungueltige Batches erreichen das Netz nicht.
        val local = FakeEventConnection(URL("https://unused.invalid"))
        val (lt, lopened) = transport(local)
        assertEquals(EventTransportResult.InvalidInput, lt.send(emptyList()))
        assertEquals(EventTransportResult.InvalidInput, lt.send(List(101) { event("%08d-1111-4111-8111-111111111111".format(it)) }))
        assertEquals(EventTransportResult.InvalidInput, lt.send(listOf(event(ids[0]), event(ids[0]))))
        assertEquals(EventTransportResult.InvalidInput, lt.send(listOf(OutgoingEvent(ids[0], "kaputt".toByteArray()))))
        assertEquals(EventTransportResult.InvalidInput, lt.send(listOf(OutgoingEvent(ids[0], event(ids[1]).payloadBytes()))))
        assertTrue(lopened.isEmpty())
        assertNull(local.fixedLength)
    }
}
