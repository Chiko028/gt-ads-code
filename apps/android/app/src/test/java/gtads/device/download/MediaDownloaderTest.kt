package gtads.device.download

import gtads.device.manifest.ManifestVerification
import gtads.device.manifest.VerifiedMedia
import gtads.device.manifest.verifyManifest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
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
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/** Eine simulierte Antwort ohne Netzwerk. */
private class ResponseSpec(
    val status: Int,
    val body: ByteArray = ByteArray(0),
    val headers: Map<String, String> = emptyMap(),
    val stream: (() -> InputStream)? = null,
)

/** Zeichnet jede Anfrage auf und liefert die vorbereiteten Antworten der Reihe nach. */
private class FakeServer(private val responses: List<ResponseSpec>) {
    val connections = mutableListOf<FakeConnection>()

    fun open(url: URL): HttpURLConnection {
        val spec = responses.getOrElse(connections.size) { responses.last() }
        return FakeConnection(url, spec).also { connections.add(it) }
    }
}

private class TrackingInputStream(private val delegate: InputStream) : InputStream() {
    var closed = false
        private set

    override fun read(): Int = delegate.read()
    override fun read(buffer: ByteArray, offset: Int, length: Int): Int = delegate.read(buffer, offset, length)
    override fun close() {
        closed = true
        delegate.close()
    }
}

/** Liefert genau [limit] Bytes und wirft danach eine Unterbrechung. */
private class InterruptingInputStream(private val bytes: ByteArray, private val limit: Int) : InputStream() {
    private var position = 0

    override fun read(): Int {
        if (position >= limit) throw IOException("synthetische Unterbrechung")
        return bytes[position++].toInt() and 0xff
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (position >= limit) throw IOException("synthetische Unterbrechung")
        val count = minOf(length, limit - position)
        System.arraycopy(bytes, position, buffer, offset, count)
        position += count
        return count
    }
}

private class FakeConnection(url: URL, private val spec: ResponseSpec) : HttpURLConnection(url) {
    val requestHeaders = HashMap<String, String>()
    val streams = mutableListOf<TrackingInputStream>()
    var disconnected = false
        private set

    override fun connect() = Unit
    override fun disconnect() {
        disconnected = true
    }

    override fun usingProxy() = false
    override fun setRequestProperty(key: String, value: String) {
        requestHeaders[key] = value
    }

    override fun getResponseCode(): Int = spec.status

    override fun getHeaderField(name: String): String? =
        spec.headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value

    override fun getInputStream(): InputStream {
        val tracking = TrackingInputStream(spec.stream?.invoke() ?: ByteArrayInputStream(spec.body))
        streams.add(tracking)
        return tracking
    }

    override fun getErrorStream(): InputStream {
        val tracking = TrackingInputStream(ByteArrayInputStream(spec.body))
        streams.add(tracking)
        return tracking
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MediaDownloaderTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val manifestKeys: KeyPair =
        KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()

    private val mediaBytes = syntheticMedia(12_000, 7)
    private val media = VerifiedMedia.of(MEDIA_ID, sha256Hex(mediaBytes), mediaBytes.size.toLong())!!

    @Test
    fun unterbrochenerDownloadWirdMitRangeOffsetFortgesetztUndBytegenauAbgeschlossen() {
        val media = verifiedMedia(mediaBytes)
        val directory = folder.newFolder("resume")
        val part = MediaDownloader.partFile(directory, media)
        val target = MediaDownloader.targetFile(directory, media)
        val server = FakeServer(
            listOf(
                ResponseSpec(
                    status = 200,
                    headers = mapOf("Content-Length" to mediaBytes.size.toString()),
                    stream = { InterruptingInputStream(mediaBytes, 5_000) },
                ),
                ResponseSpec(
                    status = 206,
                    body = mediaBytes.copyOfRange(5_000, mediaBytes.size),
                    headers = mapOf(
                        "Content-Range" to "bytes 5000-11999/12000",
                        "Content-Length" to "7000",
                    ),
                ),
            ),
        )
        val downloader = MediaDownloader(directory, BASE_URL, server::open) { false }

        val interrupted = downloader.download(GRANT, media)

        assertTrue(interrupted is MediaDownloadResult.Retryable)
        assertFalse(target.exists())
        assertEquals(5_000L, part.length())

        val resumed = downloader.download(GRANT, media)

        assertTrue(resumed is MediaDownloadResult.Completed)
        val completed = resumed as MediaDownloadResult.Completed
        assertEquals(media.sha256, completed.sha256)
        assertEquals(media.sizeBytes, completed.sizeBytes)
        assertArrayEquals(mediaBytes, target.readBytes())
        assertEquals(media.sha256, sha256Hex(target.readBytes()))
        assertFalse(part.exists())
        assertEquals("media-${media.sha256}.bin", target.name)
        assertFalse(target.name.contains(MEDIA_ID))

        assertEquals(2, server.connections.size)
        val first = server.connections[0]
        val second = server.connections[1]
        assertNull(first.requestHeaders["Range"])
        assertEquals("bytes=5000-", second.requestHeaders["Range"])
        assertEquals("\"${media.sha256}\"", second.requestHeaders["If-Range"])
        assertNull(second.requestHeaders["Authorization"])
        assertFalse(second.instanceFollowRedirects)
        assertEquals(MediaDownloader.TIMEOUT_MS, second.connectTimeout)
        assertEquals(MediaDownloader.TIMEOUT_MS, second.readTimeout)
        assertTrue(first.disconnected)
        assertTrue(second.disconnected)
        assertTrue(first.streams.isNotEmpty() && first.streams.all { it.closed })
        assertTrue(second.streams.isNotEmpty() && second.streams.all { it.closed })
        assertFalse(interrupted.toString().contains("ticket"))
        assertFalse(resumed.toString().contains("ticket"))
    }

    @Test
    fun tabelleFehlerhafterAntwortenErzeugtNieEineVollstaendigeDatei() {
        val wrongFull = mediaBytes.copyOf().also { it[0] = (it[0].toInt() xor 0x01).toByte() }
        val wrongSize = mediaBytes + byteArrayOf(1)
        val cases = listOf(
            FailureCase(
                name = "falscher_content_range_start",
                partBytes = mediaBytes.copyOfRange(0, 4_000),
                response = ResponseSpec(
                    status = 206,
                    body = mediaBytes.copyOfRange(3_000, mediaBytes.size),
                    headers = mapOf(
                        "Content-Range" to "bytes 3000-11999/12000",
                        "Content-Length" to "9000",
                    ),
                ),
                expectedPartLength = null,
                expect = { it == MediaDownloadResult.IntegrityFailure(MediaIntegrityFailure.CONTENT_RANGE) },
            ),
            FailureCase(
                name = "falsches_content_range_ende",
                partBytes = mediaBytes.copyOfRange(0, 4_000),
                response = ResponseSpec(
                    status = 206,
                    body = mediaBytes.copyOfRange(4_000, 11_001),
                    headers = mapOf(
                        "Content-Range" to "bytes 4000-11000/12000",
                        "Content-Length" to "7001",
                    ),
                ),
                expectedPartLength = null,
                expect = { it == MediaDownloadResult.IntegrityFailure(MediaIntegrityFailure.CONTENT_RANGE) },
            ),
            FailureCase(
                name = "falsche_content_range_gesamtgroesse",
                partBytes = mediaBytes.copyOfRange(0, 4_000),
                response = ResponseSpec(
                    status = 206,
                    body = mediaBytes.copyOfRange(4_000, mediaBytes.size),
                    headers = mapOf(
                        "Content-Range" to "bytes 4000-11999/13000",
                        "Content-Length" to "8000",
                    ),
                ),
                expectedPartLength = null,
                expect = { it == MediaDownloadResult.IntegrityFailure(MediaIntegrityFailure.CONTENT_RANGE) },
            ),
            FailureCase(
                name = "ueberschrittene_groesse",
                partBytes = null,
                response = ResponseSpec(
                    status = 200,
                    body = wrongSize,
                    headers = mapOf("Content-Length" to wrongSize.size.toString()),
                ),
                expectedPartLength = null,
                expect = { it == MediaDownloadResult.IntegrityFailure(MediaIntegrityFailure.TOO_LARGE) },
            ),
            FailureCase(
                name = "falscher_hash",
                partBytes = null,
                response = ResponseSpec(
                    status = 200,
                    body = wrongFull,
                    headers = mapOf("Content-Length" to wrongFull.size.toString()),
                ),
                expectedPartLength = null,
                expect = { it == MediaDownloadResult.IntegrityFailure(MediaIntegrityFailure.HASH) },
            ),
            FailureCase(
                name = "abgelaufene_freigabe",
                partBytes = mediaBytes.copyOfRange(0, 4_000),
                response = ResponseSpec(status = 403),
                expectedPartLength = 4_000L,
                expect = { it == MediaDownloadResult.GrantExpired },
            ),
            FailureCase(
                name = "http_200_nach_range_startet_neu",
                partBytes = mediaBytes.copyOfRange(0, 4_000),
                response = ResponseSpec(
                    status = 200,
                    body = mediaBytes,
                    headers = mapOf("Content-Length" to mediaBytes.size.toString()),
                ),
                expectedPartLength = null,
                expectedRange = "bytes=4000-",
                expectComplete = true,
                expect = { it is MediaDownloadResult.Completed },
            ),
            FailureCase(
                name = "range_416_mit_unvollstaendigem_rest",
                partBytes = mediaBytes.copyOfRange(0, 4_000),
                response = ResponseSpec(status = 416, headers = mapOf("Content-Range" to "bytes */12000")),
                expectedPartLength = null,
                expect = { it == MediaDownloadResult.RestartRequired },
            ),
            FailureCase(
                name = "range_416_mit_vollstaendigem_rest",
                partBytes = mediaBytes,
                response = ResponseSpec(status = 416, headers = mapOf("Content-Range" to "bytes */12000")),
                expectedPartLength = null,
                expectComplete = true,
                expect = { it is MediaDownloadResult.Completed },
            ),
            FailureCase(
                name = "range_416_mit_falschem_rest_hash",
                partBytes = wrongFull,
                response = ResponseSpec(status = 416, headers = mapOf("Content-Range" to "bytes */12000")),
                expectedPartLength = null,
                expect = { it == MediaDownloadResult.RestartRequired },
            ),
            FailureCase(
                name = "fremde_origin",
                partBytes = null,
                grantUrl = "https://evil.invalid/basis/v1/device/downloads/SYN-media?ticket=SYN",
                response = ResponseSpec(status = 200, body = mediaBytes),
                expectedPartLength = null,
                expect = { it == MediaDownloadResult.InvalidInput },
                expectNoConnection = true,
            ),
            FailureCase(
                name = "weiterleitung",
                partBytes = null,
                response = ResponseSpec(
                    status = 302,
                    headers = mapOf("Location" to "https://evil.invalid/basis/v1/device/downloads/SYN-media?ticket=SYN"),
                ),
                expectedPartLength = null,
                expect = { it == MediaDownloadResult.Unexpected(302) },
            ),
            FailureCase(
                name = "206_ohne_vorherigen_range",
                partBytes = null,
                response = ResponseSpec(
                    status = 206,
                    body = mediaBytes,
                    headers = mapOf(
                        "Content-Range" to "bytes 0-11999/12000",
                        "Content-Length" to "12000",
                    ),
                ),
                expectedPartLength = null,
                expect = { it == MediaDownloadResult.IntegrityFailure(MediaIntegrityFailure.CONTENT_RANGE) },
            ),
            FailureCase(
                name = "206_kuerzer_als_content_range",
                partBytes = mediaBytes.copyOfRange(0, 4_000),
                response = ResponseSpec(
                    status = 206,
                    body = mediaBytes.copyOfRange(4_000, 9_000),
                    headers = mapOf("Content-Range" to "bytes 4000-11999/12000"),
                ),
                expectedPartLength = null,
                expect = { it == MediaDownloadResult.IntegrityFailure(MediaIntegrityFailure.INCOMPLETE) },
            ),
            FailureCase(
                name = "groesse_ueber_servergrenze",
                partBytes = null,
                mediaOverride = VerifiedMedia.of(
                    MEDIA_ID,
                    sha256Hex(mediaBytes),
                    MediaDownloader.MAX_MEDIA_BYTES + 1L,
                )!!,
                response = ResponseSpec(status = 200, body = mediaBytes),
                expectedPartLength = null,
                expect = { it == MediaDownloadResult.InvalidInput },
                expectNoConnection = true,
            ),
        )

        for (case in cases) {
            val directory = folder.newFolder(case.name)
            val part = MediaDownloader.partFile(directory, case.media)
            case.partBytes?.let { part.writeBytes(it) }
            val server = FakeServer(listOf(case.response))

            val result = MediaDownloader(directory, BASE_URL, server::open) { false }
                .download(case.grantUrl, case.media)

            assertTrue("${case.name}: $result", case.expect(result))
            assertFalse("${case.name}: Freigabe/URL im Ergebnis", result.toString().contains("ticket"))
            val target = MediaDownloader.targetFile(directory, case.media)
            if (case.expectComplete) {
                assertTrue("${case.name}: Zieldatei fehlt", target.isFile)
                assertEquals(case.media.sizeBytes, target.length())
                assertEquals(case.media.sha256, sha256Hex(target.readBytes()))
                assertFalse(part.exists())
            } else {
                assertFalse("${case.name}: unerwartete Zieldatei", target.exists())
            }
            if (case.expectedPartLength == null) {
                assertFalse("${case.name}: Teildatei blieb zurueck", part.exists())
            } else {
                assertEquals("${case.name}: Teildatei", case.expectedPartLength!!, part.length())
            }
            if (case.expectNoConnection) {
                assertTrue("${case.name}: unerwarteter Netzaufruf", server.connections.isEmpty())
            }
            case.expectedRange?.let {
                assertEquals(it, server.connections.single().requestHeaders["Range"])
            }
            for (connection in server.connections) {
                assertTrue("${case.name}: Verbindung nicht geschlossen", connection.disconnected)
                assertTrue("${case.name}: Stream nicht geschlossen", connection.streams.all { it.closed })
            }
        }
    }

    @Test
    fun grenzeEntsprichtServerUndProfilpruefung() {
        assertEquals(1_000_000_000L, MediaDownloader.MAX_MEDIA_BYTES)
    }

    @Test
    fun siebenunddreissigKommaFuenfMegabyteWerdenVollstaendigAbgerufen() {
        val bytes = syntheticMedia(37_500_000, 11)
        val media = VerifiedMedia.of(MEDIA_ID, sha256Hex(bytes), bytes.size.toLong())!!
        val directory = folder.newFolder("grosses_medium")
        val server = FakeServer(
            listOf(
                ResponseSpec(
                    status = 200,
                    body = bytes,
                    headers = mapOf("Content-Length" to bytes.size.toString()),
                ),
            ),
        )

        val result = MediaDownloader(directory, BASE_URL, server::open) { false }
            .download(GRANT, media)

        assertTrue("$result", result is MediaDownloadResult.Completed)
        val completed = result as MediaDownloadResult.Completed
        assertEquals(37_500_000L, completed.sizeBytes)
        assertEquals(media.sha256, completed.sha256)
        val target = MediaDownloader.targetFile(directory, media)
        assertEquals(37_500_000L, target.length())
        assertEquals(media.sha256, sha256Hex(target))
        assertFalse(MediaDownloader.partFile(directory, media).exists())
        assertEquals(1, server.connections.size)
        assertTrue(server.connections.single().disconnected)
    }

    private inner class FailureCase(
        val name: String,
        val partBytes: ByteArray?,
        val response: ResponseSpec,
        val expectedPartLength: Long?,
        val grantUrl: String = GRANT,
        val mediaOverride: VerifiedMedia? = null,
        val expectedRange: String? = null,
        val expectComplete: Boolean = false,
        val expectNoConnection: Boolean = false,
        val expect: (MediaDownloadResult) -> Boolean,
    ) {
        val media: VerifiedMedia
            get() = mediaOverride ?: this@MediaDownloaderTest.media
    }

    private fun signedManifest(bytes: ByteArray): ByteArray {
        val entry = JSONObject()
            .put("mediaId", MEDIA_ID)
            .put("sha256", sha256Hex(bytes))
            .put("sizeBytes", bytes.size)
            .put("durationMs", 5_000)
            .put("campaignId", "SYN-campaign")
            .put("startAt", "2026-12-01T08:00:00.000Z")
            .put("endAt", "2026-12-01T18:00:00.000Z")
        val payload = JSONObject()
            .put("schemaVersion", 1)
            .put("environment", "dev")
            .put("taxiId", TAXI_ID)
            .put("slotCount", 1)
            .put("entries", JSONArray().put(entry))
        val payloadBytes = payload.toString().toByteArray(Charsets.UTF_8)
        val payloadBase64 = Base64.getEncoder().encodeToString(payloadBytes)
        val version = sha256Hex(payloadBytes)
        val message = "gt-ads-manifest-v1\n$KEY_ID\n$version\n$payloadBase64"
        val signature = Signature.getInstance("SHA256withECDSA").run {
            initSign(manifestKeys.private)
            update(message.toByteArray(Charsets.UTF_8))
            sign()
        }
        return JSONObject()
            .put("schemaVersion", 1)
            .put("keyId", KEY_ID)
            .put("version", version)
            .put("payloadBase64", payloadBase64)
            .put("signatureBase64", Base64.getEncoder().encodeToString(signature))
            .toString()
            .toByteArray(Charsets.UTF_8)
    }

    private fun verifiedMedia(bytes: ByteArray): VerifiedMedia {
        val verification = verifyManifest(signedManifest(bytes), manifestKeys.public, TAXI_ID)
        assertTrue(verification is ManifestVerification.Verified)
        val media = VerifiedMedia.fromVerifiedManifest(verification as ManifestVerification.Verified, MEDIA_ID)
        assertNotNull(media)
        return media!!
    }

    private fun syntheticMedia(size: Int, seed: Int): ByteArray =
        ByteArray(size) { index -> ((index * 31 + seed) and 0xff).toByte() }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

    private fun sha256Hex(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(16 * 1024)
        file.inputStream().use { input ->
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                if (read > 0) digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
    }

    private companion object {
        const val BASE_URL = "https://gtads.example.invalid/basis"
        const val MEDIA_ID = "SYN-media-001"
        const val TAXI_ID = "SYN-taxi-001"
        const val KEY_ID = "cx075-test-key"
        const val GRANT = "https://gtads.example.invalid/basis/v1/device/downloads/SYN-media-001?ticket=SYN.ticket"
    }
}
