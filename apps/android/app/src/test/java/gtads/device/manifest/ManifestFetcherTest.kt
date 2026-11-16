package gtads.device.manifest

import gtads.device.auth.DeviceAuthClient
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
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
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/** Antwort einer simulierten Route. */
private class FakeResponse(val status: Int, val body: ByteArray = ByteArray(0), val etag: String? = null, val timeout: Boolean = false)

/** Simulierter Server ohne Netzwerk: zeichnet jede Anfrage auf und antwortet je Pfad. */
private class FakeServer(val routes: (String, Int) -> FakeResponse) {
    val requests = mutableListOf<FakeConnection>()

    fun open(url: URL): HttpURLConnection = FakeConnection(url, this).also { requests.add(it) }
    fun countFor(path: String) = requests.count { it.url.path.endsWith(path) }
}

private class FakeConnection(url: URL, private val server: FakeServer) : HttpURLConnection(url) {
    val headers = HashMap<String, String>()
    val sent = ByteArrayOutputStream()
    private var response: FakeResponse? = null

    override fun connect() = Unit
    override fun disconnect() = Unit
    override fun usingProxy() = false
    override fun setFixedLengthStreamingMode(contentLength: Int) = Unit
    override fun setRequestProperty(key: String, value: String) { headers[key] = value }
    override fun getOutputStream(): OutputStream = sent
    private fun resolve(): FakeResponse {
        val path = url.path
        return response ?: server.routes(path, server.countFor(path)).also { response = it }
    }
    override fun getResponseCode(): Int {
        val r = resolve()
        if (r.timeout) throw SocketTimeoutException("synthetisch")
        return r.status
    }
    override fun getHeaderField(name: String): String? = if (name == "ETag") resolve().etag else null
    override fun getInputStream(): InputStream = ByteArrayInputStream(resolve().body)
    override fun getErrorStream(): InputStream = ByteArrayInputStream(resolve().body)
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ManifestFetcherTest {
    private val manifestKeys: KeyPair = newKeyPair()
    private val deviceKeys: KeyPair = newKeyPair()
    private val token = "SYN-ACCESS-TOKEN-abc"
    private val nonce = "SYN-NONCE-xyz"

    private fun newKeyPair(): KeyPair =
        KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

    /** Signiertes Artefakt im CX-007/CX-042-Format (wie ManifestVerificationTest). */
    private fun artifact(taxiId: String = TAXI_ID): ByteArray {
        val entry = JSONObject().put("mediaId", "SYN-media").put("sha256", "a".repeat(64)).put("sizeBytes", 4096)
            .put("durationMs", 5000).put("campaignId", "SYN-campaign")
            .put("startAt", "2026-12-01T08:00:00.000Z").put("endAt", "2026-12-01T18:00:00.000Z")
        val payload = JSONObject().put("schemaVersion", 1).put("environment", "dev").put("taxiId", taxiId)
            .put("slotCount", 1).put("entries", JSONArray().put(entry))
        val payloadBytes = payload.toString().toByteArray(Charsets.UTF_8)
        val payloadBase64 = Base64.getEncoder().encodeToString(payloadBytes)
        val version = sha256Hex(payloadBytes)
        val message = "gt-ads-manifest-v1\n$KEY_ID\n$version\n$payloadBase64"
        val signature = Signature.getInstance("SHA256withECDSA").run {
            initSign(manifestKeys.private); update(message.toByteArray(Charsets.UTF_8)); sign()
        }
        return JSONObject().put("schemaVersion", 1).put("keyId", KEY_ID).put("version", version)
            .put("payloadBase64", payloadBase64).put("signatureBase64", Base64.getEncoder().encodeToString(signature))
            .toString().toByteArray(Charsets.UTF_8)
    }

    private fun json(value: JSONObject) = value.toString().toByteArray(Charsets.UTF_8)

    private fun authRoutes(path: String): FakeResponse? = when {
        path.endsWith("/v1/device/auth/challenge") ->
            FakeResponse(200, json(JSONObject().put("nonce", nonce).put("expires_at", "2026-12-01T08:05:00.000Z")))
        path.endsWith("/v1/device/auth/token") ->
            FakeResponse(200, json(JSONObject().put("access_token", token).put("token_type", "Bearer").put("expires_at", "2026-12-01T09:00:00.000Z")))
        else -> null
    }

    private fun fetcher(server: FakeServer): ManifestFetcher {
        val signer: (ByteArray) -> ByteArray = { bytes ->
            Signature.getInstance("SHA256withECDSA").run { initSign(deviceKeys.private); update(bytes); sign() }
        }
        val auth = DeviceAuthClient(BASE_URL, DEVICE_ID, signer, server::open) { false }
        return ManifestFetcher(BASE_URL, auth, manifestKeys.public, TAXI_ID, server::open) { false }
    }

    @Test
    fun abrufMitGeraeteauthentifizierungLiefertErstNachPruefungEinenKandidaten() {
        val bytes = artifact()
        val server = FakeServer { path, _ -> authRoutes(path) ?: FakeResponse(200, bytes, "\"etag-1\"") }

        val result = fetcher(server).fetch(current = null)

        assertTrue(result is ManifestFetchResult.Candidate)
        val state = (result as ManifestFetchResult.Candidate).state
        assertEquals("\"etag-1\"", state.etag)
        assertArrayEquals(bytes, state.manifest.bytes())

        // Challenge -> Signatur ueber die Vertragsnachricht -> Token -> Manifest, in dieser Reihenfolge.
        assertEquals(listOf("/basis/v1/device/auth/challenge", "/basis/v1/device/auth/token", "/basis/v1/device/manifest"),
            server.requests.map { it.url.path })
        assertEquals(DEVICE_ID, JSONObject(server.requests[0].sent.toString("UTF-8")).getString("device_id"))
        val tokenRequest = JSONObject(server.requests[1].sent.toString("UTF-8"))
        assertEquals(nonce, tokenRequest.getString("nonce"))
        val valid = Signature.getInstance("SHA256withECDSA").run {
            initVerify(deviceKeys.public)
            update("gt-ads-auth-v1\n$DEVICE_ID\n$nonce".toByteArray(Charsets.UTF_8))
            verify(Base64.getDecoder().decode(tokenRequest.getString("signature")))
        }
        assertTrue(valid)
        val manifestRequest = server.requests[2]
        assertEquals("GET", manifestRequest.requestMethod)
        assertEquals("Bearer $token", manifestRequest.headers["Authorization"])
        assertEquals("1", manifestRequest.headers["X-GT-Ads-Api-Version"])
        assertNull("If-None-Match ohne geprueften Stand", manifestRequest.headers["If-None-Match"])
        assertFalse(manifestRequest.instanceFollowRedirects)
        assertEquals(ManifestFetcher.TIMEOUT_MS, manifestRequest.connectTimeout)
        assertEquals(ManifestFetcher.TIMEOUT_MS, manifestRequest.readTimeout)

        // Ein falsch gebundenes oder manipuliertes Artefakt wird nie Kandidat.
        val wrongTaxi = FakeServer { path, _ -> authRoutes(path) ?: FakeResponse(200, artifact("SYN-fremd"), "\"e\"") }
        assertEquals(ManifestFetchResult.Invalid(ManifestFailure.TAXI), fetcher(wrongTaxi).fetch(null))
    }

    @Test
    fun antwortenWerdenUnterscheidbarEingeordnet() {
        val first = fetcher(FakeServer { path, _ -> authRoutes(path) ?: FakeResponse(200, artifact(), "\"etag-1\"") }).fetch(null)
        val current = (first as ManifestFetchResult.Candidate).state

        data class Case(val name: String, val current: VerifiedManifestState?, val manifest: FakeResponse?, val auth: ((String) -> FakeResponse?)?, val expected: ManifestFetchResult)
        val cases = listOf(
            Case("304 mit geprueftem Stand", current, FakeResponse(304, etag = "\"etag-1\""), null, ManifestFetchResult.Unchanged),
            Case("304 ohne geprueften Stand", null, FakeResponse(304, etag = "\"etag-1\""), null, ManifestFetchResult.Unexpected(304)),
            Case("304 mit fremdem ETag", current, FakeResponse(304, etag = "\"anders\""), null, ManifestFetchResult.Unexpected(304)),
            Case("401 beim Manifest", current, FakeResponse(401), null, ManifestFetchResult.AuthenticationRequired),
            Case("403 beim Manifest", null, FakeResponse(403), null, ManifestFetchResult.AuthenticationRequired),
            Case("403 bei der Anmeldung", null, null, { p -> if (p.endsWith("/token")) FakeResponse(403) else authRoutes(p) }, ManifestFetchResult.AuthenticationRequired),
            Case("Zeitlimit", current, FakeResponse(200, timeout = true), null, ManifestFetchResult.Timeout),
            Case("zu gross", null, FakeResponse(200, ByteArray(ManifestFetcher.MAX_MANIFEST_BYTES + 1) { 'x'.code.toByte() }, "\"e\""), null, ManifestFetchResult.TooLarge),
            Case("Weiterleitung", null, FakeResponse(302), null, ManifestFetchResult.Unexpected(302)),
            Case("503", current, FakeResponse(503), null, ManifestFetchResult.Unavailable),
            Case("200 ohne ETag", null, FakeResponse(200, artifact(), null), null, ManifestFetchResult.Unavailable),
        )
        for (case in cases) {
            val server = FakeServer { path, _ -> (case.auth ?: ::authRoutes)(path) ?: case.manifest!! }
            val result = fetcher(server).fetch(case.current)
            assertEquals(case.name, case.expected, result)
            assertFalse(case.name, result is ManifestFetchResult.Candidate)
            // Keine Nachweise in Ergebnissen.
            assertFalse(result.toString().contains(token))
            assertFalse(result.toString().contains(nonce))
            val manifestRequest = server.requests.firstOrNull { it.url.path.endsWith("/v1/device/manifest") }
            if (case.current != null && manifestRequest != null) {
                assertEquals(case.name, case.current.etag, manifestRequest.headers["If-None-Match"])
            }
        }
        // Der bisherige gepruefte Stand bleibt unveraendert nutzbar.
        assertArrayEquals(artifact().size.let { current.manifest.bytes() }, current.manifest.bytes())
        assertEquals("\"etag-1\"", current.etag)
    }

    private companion object {
        const val BASE_URL = "https://gtads.example.invalid/basis"
        const val DEVICE_ID = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e"
        const val TAXI_ID = "SYN-taxi-001"
        const val KEY_ID = "cx074-test-key"
    }
}
