package gtads.device.config

import android.content.Context
import gtads.device.auth.DeviceAuthClient
import gtads.device.control.ControlRuntime
import gtads.device.download.MediaDownloadResult
import gtads.device.download.MediaDownloader
import gtads.device.manifest.VerifiedMedia
import gtads.device.registration.REGISTRATION_FILE_NAME
import gtads.device.registration.RegistrationRepository
import gtads.device.sync.SyncRuntime
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

private class Reply(val status: Int, val body: ByteArray = ByteArray(0), val headers: Map<String, String> = emptyMap())

/** Simulierter Server ohne Netzwerk; zeichnet Pfade und Kopfzeilen auf. */
private class FakeServer(var route: (String) -> Reply) {
    val requests = mutableListOf<FakeConnection>()
    fun open(url: URL): HttpURLConnection = FakeConnection(url, this).also { requests.add(it) }
}

private class FakeConnection(url: URL, private val server: FakeServer) : HttpURLConnection(url) {
    val headers = HashMap<String, String>()
    private val sent = ByteArrayOutputStream()
    private val reply by lazy { server.route(url.path + (url.query?.let { "?$it" } ?: "")) }
    override fun connect() = Unit
    override fun disconnect() = Unit
    override fun usingProxy() = false
    override fun setFixedLengthStreamingMode(contentLength: Int) = Unit
    override fun setRequestProperty(key: String, value: String) { headers[key] = value }
    override fun getRequestProperty(key: String): String? = headers[key]
    override fun getOutputStream(): OutputStream = sent
    override fun getResponseCode(): Int = reply.status
    override fun getHeaderField(name: String): String? = reply.headers.entries.firstOrNull { it.key.equals(name, true) }?.value
    override fun getContentLengthLong(): Long = reply.body.size.toLong()
    override fun getInputStream(): InputStream = ByteArrayInputStream(reply.body)
    override fun getErrorStream(): InputStream = ByteArrayInputStream(reply.body)
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DeviceConfigTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var app: Context
    private val deviceKeys = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    private val manifestKeys = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    private val spki = Base64.getEncoder().encodeToString(manifestKeys.public.encoded)
    private val mediaId = "0e0f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b"
    private val mediaBytes = ByteArray(64) { it.toByte() }
    private var configBody: JSONObject = JSONObject()
    private var configStatus = 200
    private lateinit var server: FakeServer

    private fun json(value: JSONObject) = value.toString().toByteArray(Charsets.UTF_8)

    private fun sha256Hex(bytes: ByteArray) =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

    @Before
    fun setUp() {
        app = RuntimeEnvironment.getApplication()
        deleteRegistration()
        assertTrue(RegistrationRepository(File(app.noBackupFilesDir, REGISTRATION_FILE_NAME)).writeRegistered(DEVICE_ID, BASE))
        configBody = JSONObject().put("taxi_id", "SYN-TAXI-149")
            .put("manifest_key", JSONObject().put("key_id", "cx148").put("public_key_spki", spki)).put("downloads_available", true)
        configStatus = 200
        server = FakeServer { path ->
            when {
                path.endsWith("/v1/device/auth/challenge") -> Reply(200, json(JSONObject().put("nonce", "SYN-NONCE")))
                path.endsWith("/v1/device/auth/token") -> Reply(200, json(JSONObject().put("access_token", "SYN-TOKEN").put("token_type", "Bearer")))
                path.endsWith("/v1/device/config") -> Reply(configStatus, json(configBody))
                path.endsWith("/v1/device/media/$mediaId/grant") ->
                    Reply(200, json(JSONObject().put("path", "/v1/device/downloads/$mediaId?ticket=SYN-TICKET")))
                path.contains("/v1/device/downloads/$mediaId?ticket=") ->
                    Reply(200, mediaBytes, mapOf("Content-Length" to mediaBytes.size.toString()))
                else -> Reply(404)
            }
        }
        DeviceRuntimeSetup.resetForTest()
        DeviceRuntimeSetup.openConnection = server::open
        DeviceRuntimeSetup.authFactory = { binding ->
            DeviceAuthClient(binding.baseUrl, binding.deviceId, { bytes ->
                java.security.Signature.getInstance("SHA256withECDSA").run { initSign(deviceKeys.private); update(bytes); sign() }
            }, server::open) { false }
        }
        SyncRuntime.resetForTest()
        ControlRuntime.resetForTest()
    }

    @After
    fun tearDown() {
        DeviceRuntimeSetup.resetForTest()
        SyncRuntime.resetForTest()
        ControlRuntime.resetForTest()
        app.getSharedPreferences("gtads-device-config", Context.MODE_PRIVATE).edit().clear().commit()
        deleteRegistration()
    }

    private fun deleteRegistration() {
        val file = File(app.noBackupFilesDir, REGISTRATION_FILE_NAME)
        file.delete()
        File(file.path + ".new").delete()
        File(file.path + ".bak").delete()
    }

    private fun binding() = RegistrationRepository(app).readBinding()!!

    @Test
    fun konfigurationWirdGeholtGespeichertUndSchaltetSynchronisierungUndBefehlsabrufFrei() {
        // Ohne Konfiguration: weder Synchronisierung noch Befehlsabruf.
        DeviceRuntimeSetup.install()
        assertNull(DeviceRuntimeSetup.syncConfiguration(app, binding()))
        assertNull(ControlRuntime.poller(app))

        val result = DeviceRuntimeSetup.refresh(app)
        assertTrue(result is DeviceConfigResult.Fetched)
        val config = requireNotNull(DeviceRuntimeSetup.syncConfiguration(app, binding()))
        assertEquals("SYN-TAXI-149", config.taxiId)
        assertTrue(config.trustedManifestKey.encoded.contentEquals(manifestKeys.public.encoded))
        assertNotNull("Befehlsabruf erhaelt die Taxi-Bindung", ControlRuntime.poller(app))
        // Geraeteanmeldung: Bearer-Token aus Challenge/Response.
        assertEquals("Bearer SYN-TOKEN", server.requests.first { it.url.path.endsWith("/v1/device/config") }.headers["Authorization"])
    }

    @Test
    fun ohneZuordnungOderBeiFehlernBleibtDieZuletztGueltigeKonfiguration() {
        DeviceRuntimeSetup.install()
        assertTrue(DeviceRuntimeSetup.refresh(app) is DeviceConfigResult.Fetched)

        // Server nicht erreichbar bzw. Anmeldung abgelehnt: gespeicherter Stand bleibt.
        configStatus = 503
        assertEquals(DeviceConfigResult.Unavailable, DeviceRuntimeSetup.refresh(app))
        configStatus = 401
        assertEquals(DeviceConfigResult.AuthenticationRequired, DeviceRuntimeSetup.refresh(app))
        assertEquals("SYN-TAXI-149", DeviceRuntimeSetup.syncConfiguration(app, binding())?.taxiId)

        // Unbrauchbarer Schluessel wird nie gespeichert.
        configStatus = 200
        configBody = JSONObject(configBody.toString()).put("manifest_key", JSONObject().put("key_id", "x").put("public_key_spki", "kein-schluessel"))
        assertEquals(DeviceConfigResult.Unavailable, DeviceRuntimeSetup.refresh(app))
        assertEquals("SYN-TAXI-149", DeviceRuntimeSetup.syncConfiguration(app, binding())?.taxiId)

        // Zuordnung aufgehoben: kein Taxi -> keine Synchronisierung, kein Befehlsabruf.
        configBody = JSONObject(configBody.toString()).put("taxi_id", JSONObject.NULL)
            .put("manifest_key", JSONObject().put("key_id", "cx148").put("public_key_spki", spki))
        assertTrue(DeviceRuntimeSetup.refresh(app) is DeviceConfigResult.Fetched)
        assertNull(DeviceRuntimeSetup.syncConfiguration(app, binding()))
        assertNull(ControlRuntime.poller(app))

        // Neue Registrierung (andere Generation) verwirft die alte Konfiguration.
        configBody = JSONObject(configBody.toString()).put("taxi_id", "SYN-TAXI-149")
        DeviceRuntimeSetup.refresh(app)
        deleteRegistration()
        assertTrue(RegistrationRepository(File(app.noBackupFilesDir, REGISTRATION_FILE_NAME)).writeRegistered("11111111-2222-4333-8444-555555555555", BASE))
        assertNull(DeviceRuntimeSetup.syncConfiguration(app, binding()))
    }

    @Test
    fun freigabeLiefertEineUrlDieDerVorhandeneDownloaderAkzeptiertUndLaedt() {
        val media = VerifiedMedia.of(mediaId, sha256Hex(mediaBytes), mediaBytes.size.toLong())!!
        val grants = MediaGrantClient(BASE, DeviceRuntimeSetup.authFactory(binding()), server::open)
        val url = grants.grantUrl(media)
        assertEquals("$BASE/v1/device/downloads/$mediaId?ticket=SYN-TICKET", url)

        val directory = temporary.newFolder("media")
        val result = MediaDownloader(directory, BASE, server::open) { false }.download(url!!, media)
        assertTrue("Download ueber die Ticket-URL: $result", result is MediaDownloadResult.Completed)

        // Fremder Pfad in der Antwort wird nicht uebernommen.
        val foreign = FakeServer { path ->
            if (path.endsWith("/grant")) Reply(200, json(JSONObject().put("path", "/v1/device/downloads/anderes?ticket=x"))) else server.route(path)
        }
        assertNull(MediaGrantClient(BASE, DeviceAuthClient(BASE, DEVICE_ID, { it }, foreign::open) { false }, foreign::open).grantUrl(media))
    }

    private companion object {
        const val BASE = "https://gtads.example.invalid/basis"
        const val DEVICE_ID = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e"
    }
}
