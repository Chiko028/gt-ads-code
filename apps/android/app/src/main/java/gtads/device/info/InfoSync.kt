package gtads.device.info

import android.content.Context
import gtads.device.auth.DeviceAuthClient
import gtads.device.auth.DeviceAuthResult
import gtads.device.auth.DeviceHttp
import gtads.device.auth.DeviceHttpResult
import gtads.device.identity.DeviceIdentity
import gtads.device.registration.RegistrationRepository
import gtads.device.sync.SyncAuthGate
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** Letzter guter Stand als kleine private Datei; atomar ersetzt. */
class InfoStore(directory: File) {
    private val file = File(directory, "info-cards.json")
    private val part = File(directory, "info-cards.json.part")

    fun read(): InfoData? = try {
        if (file.isFile && file.length() <= InfoSync.MAX_BYTES) InfoCards.parse(file.readBytes()) else null
    } catch (_: Exception) {
        null
    }

    fun write(body: ByteArray): Boolean = try {
        part.writeBytes(body)
        part.renameTo(file)
    } catch (_: Exception) {
        false
    }

    /** Auch ein in der Zukunft liegender Zeitstempel (Uhrsprung) gilt als faellig. */
    fun isDue(nowMs: Long): Boolean = !file.isFile || nowMs - file.lastModified() !in 0L until InfoSync.INTERVAL_MS
}

class InfoSync(
    baseUrl: String,
    private val auth: DeviceAuthClient,
    private val store: InfoStore,
    private val nowMs: () -> Long = System::currentTimeMillis,
    openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
) {
    private val http = DeviceHttp(baseUrl, openConnection, TIMEOUT_MS, TIMEOUT_MS)

    /** Hoechstens alle drei Stunden; ungueltige oder leere Antworten ersetzen nichts. */
    fun run(): Boolean {
        if (!store.isDue(nowMs())) return false
        val token = (auth.obtainToken() as? DeviceAuthResult.Token)?.accessToken ?: return false
        val response = http.call("GET", PATH, null, token, null, MAX_BYTES) as? DeviceHttpResult.Response ?: return false
        if (response.status != 200) return false
        val data = InfoCards.parse(response.body) ?: return false
        if (data.weather == null && data.news == null) return false
        return store.write(response.body)
    }

    companion object {
        const val PATH = "/v1/device/info"
        const val TIMEOUT_MS = 15_000
        const val MAX_BYTES = 65_536
        const val INTERVAL_MS = 3L * 60L * 60L * 1000L

        fun runFor(context: Context) {
            val app = context.applicationContext
            if (SyncAuthGate(app).isSuspended()) return
            val binding = RegistrationRepository(app).readBinding() ?: return
            val auth = DeviceAuthClient(
                baseUrl = binding.baseUrl,
                deviceId = binding.deviceId,
                sign = { bytes -> DeviceIdentity().sign(bytes) },
            )
            InfoSync(binding.baseUrl, auth, InfoStore(app.filesDir)).run()
        }
    }
}
