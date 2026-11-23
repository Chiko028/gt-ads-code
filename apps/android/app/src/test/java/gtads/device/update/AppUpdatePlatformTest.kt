package gtads.device.update

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.work.WorkManager
import gtads.device.testsupport.initializeTestWorkManager
import gtads.device.auth.DeviceAuthClient
import gtads.device.config.DeviceRuntimeSetup
import gtads.device.registration.REGISTRATION_FILE_NAME
import gtads.device.registration.RegistrationRepository
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

private const val BASE = "https://srv.example:8443"
private const val DEVICE_ID = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
private const val RELEASE = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"

private class Reply(val status: Int, val body: ByteArray = ByteArray(0), val headers: Map<String, String> = emptyMap())

private class FakeServer(var route: (String, String) -> Reply) {
    val requests = mutableListOf<FakeConnection>()
    fun open(url: URL): HttpURLConnection = FakeConnection(url, this).also { requests.add(it) }
}

private class FakeConnection(url: URL, private val server: FakeServer) : HttpURLConnection(url) {
    val headers = HashMap<String, String>()
    val sent = ByteArrayOutputStream()
    private val reply by lazy { server.route(method, url.path + (url.query?.let { "?$it" } ?: "")) }
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

/** Android-Grenze der App-Updates: Serverantwort, Download, Rueckmeldung, Manifest und Zeitplan. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AppUpdatePlatformTest {
    private lateinit var app: Context
    private lateinit var server: FakeServer
    private val apkBytes = ByteArray(2048) { (it % 251).toByte() }
    private var offerBody: JSONObject = JSONObject().put("update", JSONObject.NULL)
    private val deviceKeys = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()

    private fun json(value: JSONObject) = value.toString().toByteArray(Charsets.UTF_8)

    private fun offerJson(path: String = "/v1/device/app-downloads/$RELEASE?ticket=SYN-TICKET") = JSONObject().put(
        "update",
        JSONObject().put("release_id", RELEASE).put("version_code", 3).put("version_name", "0.3.0")
            .put("sha256", sha256Hex(apkBytes)).put("size_bytes", apkBytes.size).put("download_path", path),
    )

    @Before
    fun setUp() {
        app = RuntimeEnvironment.getApplication()
        deleteRegistration()
        assertTrue(RegistrationRepository(File(app.noBackupFilesDir, REGISTRATION_FILE_NAME)).writeRegistered(DEVICE_ID, BASE))
        server = FakeServer { _, path ->
            when {
                path.endsWith("/v1/device/auth/challenge") -> Reply(200, json(JSONObject().put("nonce", "SYN-NONCE")))
                path.endsWith("/v1/device/auth/token") -> Reply(200, json(JSONObject().put("access_token", "SYN-TOKEN").put("token_type", "Bearer")))
                path.endsWith("/v1/device/app-update") -> Reply(200, json(offerBody))
                path.endsWith("/v1/device/app-update/report") -> Reply(204)
                path.startsWith("/v1/device/app-downloads/$RELEASE?ticket=") ->
                    Reply(200, apkBytes, mapOf("Content-Length" to apkBytes.size.toString()))
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
    }

    @After
    fun tearDown() {
        DeviceRuntimeSetup.resetForTest()
        File(app.filesDir, AndroidAppUpdatePorts.UPDATE_DIRECTORY).deleteRecursively()
        deleteRegistration()
    }

    private fun deleteRegistration() {
        val file = File(app.noBackupFilesDir, REGISTRATION_FILE_NAME)
        file.delete()
        File(file.path + ".new").delete()
        File(file.path + ".bak").delete()
    }

    private fun client(): AppUpdateClient {
        val binding = RegistrationRepository(app).readBinding()!!
        return AppUpdateClient(binding.baseUrl, DeviceRuntimeSetup.authFactory(binding), server::open)
    }

    @Test
    fun serverantwortWirdStrengGeprueft() {
        assertEquals(OfferResult.None, client().fetchOffer())

        offerBody = offerJson()
        val offer = (client().fetchOffer() as OfferResult.Offer).offer
        assertEquals(RELEASE, offer.releaseId)
        assertEquals(3L, offer.versionCode)
        assertEquals("$BASE/v1/device/app-downloads/$RELEASE?ticket=SYN-TICKET", offer.downloadUrl)
        assertEquals("Bearer SYN-TOKEN", server.requests.last { it.url.path.endsWith("/v1/device/app-update") }.headers["Authorization"])

        // Fremder Pfad, fehlende Felder oder kaputtes JSON: nichts wird geladen.
        offerBody = offerJson(path = "/v1/device/downloads/$RELEASE?ticket=x")
        assertEquals(OfferResult.Unavailable, client().fetchOffer())
        offerBody = JSONObject().put("update", JSONObject().put("release_id", RELEASE))
        assertEquals(OfferResult.Unavailable, client().fetchOffer())
        assertEquals(OfferResult.Unavailable, AppUpdateClient.parseOffer("kein json".toByteArray(), BASE))
    }

    @Test
    fun downloadNutztDenAppPfadUndPrueftDenHash() {
        offerBody = offerJson()
        val binding = RegistrationRepository(app).readBinding()!!
        val ports = AndroidAppUpdatePorts(app, binding, client(), server::open)
        val offer = (client().fetchOffer() as OfferResult.Offer).offer

        val done = ports.download(offer) as DownloadOutcome.Completed
        assertTrue(done.file.readBytes().contentEquals(apkBytes))
        assertEquals(File(app.filesDir, AndroidAppUpdatePorts.UPDATE_DIRECTORY).canonicalPath, done.file.parentFile!!.canonicalPath)

        // Falscher Hash: Integritaetsfehler, keine Datei.
        val wrong = offer.copy(sha256 = "c".repeat(64))
        val failed = ports.download(wrong)
        assertTrue(failed is DownloadOutcome.Failed)
        assertEquals("download_hash", (failed as DownloadOutcome.Failed).detail)

        // Fremde Origin wird vom Downloader abgelehnt.
        val foreign = offer.copy(sha256 = "d".repeat(64), downloadUrl = "https://boese.example/v1/device/app-downloads/$RELEASE?ticket=x")
        assertEquals(DownloadOutcome.Failed("download_invalid"), ports.download(foreign))
    }

    @Test
    fun rueckmeldungGehtMitBearerAnDenServer() {
        client().report(RELEASE, "failed", "install_status_4")
        val request = server.requests.last { it.url.path.endsWith("/v1/device/app-update/report") }
        assertEquals("POST", request.requestMethod)
        assertEquals("Bearer SYN-TOKEN", request.headers["Authorization"])
        val body = JSONObject(String(request.sent.toByteArray(), Charsets.UTF_8))
        assertEquals(RELEASE, body.getString("release_id"))
        assertEquals("failed", body.getString("status"))
        assertEquals("install_status_4", body.getString("detail"))
    }

    @Test
    fun manifestNameBerechtigungUndEmpfaengerSindVorhanden() {
        val pm = app.packageManager
        assertEquals("GT Ads", app.applicationInfo.loadLabel(pm).toString())
        // Eigenes App-Icon (Logo des Betreibers) statt Android-Standardsymbol.
        assertEquals(app.resources.getIdentifier("ic_launcher", "mipmap", app.packageName), app.applicationInfo.icon)
        assertTrue(app.applicationInfo.icon != 0)
        val requested = pm.getPackageInfo(app.packageName, PackageManager.GET_PERMISSIONS).requestedPermissions?.toSet() ?: emptySet()
        assertTrue(requested.contains("android.permission.REQUEST_INSTALL_PACKAGES"))
        val replaced = pm.queryBroadcastReceivers(Intent(Intent.ACTION_MY_PACKAGE_REPLACED).setPackage(app.packageName), 0)
        assertTrue(replaced.any { it.activityInfo.name == AppUpdatedReceiver::class.java.name })
        val result = pm.queryBroadcastReceivers(
            Intent(AppUpdateInstallReceiver.ACTION).setClassName(app.packageName, AppUpdateInstallReceiver::class.java.name),
            0,
        )
        assertTrue(result.any { it.activityInfo.name == AppUpdateInstallReceiver::class.java.name })
    }

    @Test
    fun pruefungLaeuftNachDemStartUndDannAlleSechsStunden() {
        initializeTestWorkManager(app)
        AppUpdateScheduler.ensure(app)
        val workManager = WorkManager.getInstance(app)
        val periodic = workManager.getWorkInfosForUniqueWork(AppUpdateScheduler.UNIQUE_PERIODIC).get()
        assertEquals(1, periodic.size)
        assertEquals(6L * 60L * 60L * 1000L, periodic.single().periodicityInfo?.repeatIntervalMillis)
        assertEquals(1, workManager.getWorkInfosForUniqueWork(AppUpdateScheduler.UNIQUE_SOON).get().size)

        // Erneuter Start: keine doppelte Arbeit.
        AppUpdateScheduler.ensure(app)
        assertEquals(1, workManager.getWorkInfosForUniqueWork(AppUpdateScheduler.UNIQUE_PERIODIC).get().size)
        assertEquals(1, workManager.getWorkInfosForUniqueWork(AppUpdateScheduler.UNIQUE_SOON).get().size)
    }
}
