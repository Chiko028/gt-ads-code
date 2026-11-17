package gtads.device.config

import android.content.Context
import gtads.device.auth.DeviceAuthClient
import gtads.device.auth.DeviceAuthResult
import gtads.device.auth.DeviceHttp
import gtads.device.auth.DeviceHttpResult
import gtads.device.control.ControlRuntime
import gtads.device.identity.DeviceIdentity
import gtads.device.manifest.VerifiedMedia
import gtads.device.registration.RegistrationBinding
import gtads.device.registration.RegistrationRepository
import gtads.device.registration.normalizeServerBaseUrl
import gtads.device.sync.SyncConfiguration
import gtads.device.sync.SyncRuntime
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyFactory
import java.security.PublicKey
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener

/**
 * CX-149: Geraetekonfiguration vom Server (GET /v1/device/config, CX-148).
 * Enthaelt nur oeffentliche Angaben: Taxi-Kennung der aktiven Zuordnung und den
 * oeffentlichen Manifestschluessel (SPKI, Base64). Kein Geheimnis wird gespeichert.
 */
data class DeviceConfiguration(
    val taxiId: String?,
    val keyId: String?,
    val publicKeySpki: String?,
) {
    /** Oeffentlicher Schluessel fuer verifyManifest (CX-073) oder null, wenn nicht nutzbar. */
    fun manifestKey(): PublicKey? = try {
        publicKeySpki?.let {
            KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(it)))
        }
    } catch (_: Exception) {
        null
    }

    internal fun toJson(): String = JSONObject()
        .put("taxi_id", taxiId ?: JSONObject.NULL)
        .put("key_id", keyId ?: JSONObject.NULL)
        .put("public_key_spki", publicKeySpki ?: JSONObject.NULL)
        .toString()

    companion object {
        /** Prueft die Serverantwort streng; jede Abweichung ergibt null (nichts wird gespeichert). */
        internal fun parse(body: ByteArray): DeviceConfiguration? {
            val root = try {
                JSONTokener(String(body, Charsets.UTF_8)).nextValue() as? JSONObject
            } catch (_: JSONException) {
                null
            } ?: return null
            val taxi = root.opt("taxi_id")
            val taxiId = when {
                taxi == null || taxi == JSONObject.NULL -> null
                taxi is String && taxi.isNotBlank() && taxi.length <= 128 -> taxi
                else -> return null
            }
            val key = root.opt("manifest_key")
            if (key == null || key == JSONObject.NULL) return DeviceConfiguration(taxiId, null, null)
            if (key !is JSONObject) return null
            val keyId = key.opt("key_id") as? String ?: return null
            val spki = key.opt("public_key_spki") as? String ?: return null
            val config = DeviceConfiguration(taxiId, keyId, spki)
            return if (config.manifestKey() == null) null else config
        }

        /** Gespeicherte flache Form (siehe [toJson]). */
        internal fun fromJson(raw: String): DeviceConfiguration? = try {
            val json = JSONObject(raw)
            fun field(name: String): String? = if (json.isNull(name)) null else json.optString(name).takeIf { it.isNotBlank() }
            DeviceConfiguration(taxiId = field("taxi_id"), keyId = field("key_id"), publicKeySpki = field("public_key_spki"))
        } catch (_: JSONException) {
            null
        }
    }
}

/** Lokale Ablage je Registrierung (deviceId + Generation): eine Neuregistrierung verwirft alte Angaben. */
class DeviceConfigStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun read(binding: RegistrationBinding): DeviceConfiguration? {
        if (prefs.getString(KEY_BINDING, null) != bindingKey(binding)) return null
        return prefs.getString(KEY_CONFIG, null)?.let { DeviceConfiguration.fromJson(it) }
    }

    fun write(binding: RegistrationBinding, configuration: DeviceConfiguration): Boolean =
        prefs.edit().putString(KEY_BINDING, bindingKey(binding)).putString(KEY_CONFIG, configuration.toJson()).commit()

    private fun bindingKey(binding: RegistrationBinding) = binding.deviceId + "#" + binding.generation

    private companion object {
        const val PREFS = "gtads-device-config"
        const val KEY_BINDING = "binding"
        const val KEY_CONFIG = "config"
    }
}

sealed interface DeviceConfigResult {
    data class Fetched(val configuration: DeviceConfiguration) : DeviceConfigResult
    data object AuthenticationRequired : DeviceConfigResult
    data object Unavailable : DeviceConfigResult
}

/** Abruf von GET /v1/device/config mit der Geraeteanmeldung aus CX-074; keine Wiederholung. */
class DeviceConfigClient(
    baseUrl: String,
    private val auth: DeviceAuthClient,
    openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
) {
    private val http = DeviceHttp(baseUrl, openConnection, TIMEOUT_MS, TIMEOUT_MS)

    fun fetch(): DeviceConfigResult {
        val token = when (val result = auth.obtainToken()) {
            is DeviceAuthResult.Token -> result.accessToken
            DeviceAuthResult.AuthenticationRequired -> return DeviceConfigResult.AuthenticationRequired
            else -> return DeviceConfigResult.Unavailable
        }
        val response = http.call("GET", CONFIG_PATH, null, token, null, MAX_BYTES) as? DeviceHttpResult.Response
            ?: return DeviceConfigResult.Unavailable
        return when (response.status) {
            200 -> DeviceConfiguration.parse(response.body)?.let { DeviceConfigResult.Fetched(it) } ?: DeviceConfigResult.Unavailable
            401, 403 -> DeviceConfigResult.AuthenticationRequired
            else -> DeviceConfigResult.Unavailable
        }
    }

    companion object {
        const val TIMEOUT_MS = 15_000
        const val MAX_BYTES = 16_384
        private const val CONFIG_PATH = "/v1/device/config"
    }
}

/**
 * Download-Freigabe je Medium (GET /v1/device/media/<id>/grant, CX-148). Liefert die absolute
 * Ticket-URL auf dem registrierten Server, die MediaDownloader (CX-075) prueft und laedt.
 */
class MediaGrantClient(
    private val baseUrl: String,
    private val auth: DeviceAuthClient,
    openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
) {
    private val http = DeviceHttp(baseUrl, openConnection, DeviceConfigClient.TIMEOUT_MS, DeviceConfigClient.TIMEOUT_MS)

    fun grantUrl(media: VerifiedMedia): String? {
        if (!MEDIA_ID.matches(media.mediaId)) return null
        val token = (auth.obtainToken() as? DeviceAuthResult.Token)?.accessToken ?: return null
        val response = http.call("GET", "/v1/device/media/${media.mediaId}/grant", null, token, null, DeviceConfigClient.MAX_BYTES)
            as? DeviceHttpResult.Response ?: return null
        if (response.status != 200) return null
        val path = try {
            (JSONTokener(String(response.body, Charsets.UTF_8)).nextValue() as? JSONObject)?.opt("path") as? String
        } catch (_: JSONException) {
            null
        } ?: return null
        if (!path.startsWith("/v1/device/downloads/${media.mediaId}?")) return null
        val base = normalizeServerBaseUrl(baseUrl) ?: return null
        return base.trimEnd('/') + path
    }

    private companion object {
        val MEDIA_ID = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
    }
}

/**
 * Bindet die Konfiguration an die vorhandenen Laufzeiten: SyncRuntime (CX-077) und
 * ControlRuntime (CX-087) erhalten Taxi-Kennung, Manifestschluessel und Freigaben aus der
 * gespeicherten Konfiguration. Die Provider lesen nur lokal (auch auf dem Hauptthread sicher);
 * der Netzabruf erfolgt ausschliesslich ueber [refresh] im Hintergrund (SyncWorker).
 */
object DeviceRuntimeSetup {
    @Volatile
    private var installed = false

    @Volatile
    internal var authFactory: (RegistrationBinding) -> DeviceAuthClient = { binding ->
        DeviceAuthClient(binding.baseUrl, binding.deviceId, { bytes -> DeviceIdentity().sign(bytes) })
    }

    @Volatile
    internal var openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }

    @Synchronized
    fun install() {
        if (installed) return
        installed = true
        SyncRuntime.configure { context, binding -> syncConfiguration(context, binding) }
        ControlRuntime.configure { context, binding -> DeviceConfigStore(context).read(binding)?.taxiId }
    }

    internal fun resetForTest() {
        installed = false
    }

    /** Netzabruf und Ablage; nur im Hintergrund aufrufen. Ergebnis ohne Nachweise. */
    fun refresh(context: Context): DeviceConfigResult {
        val binding = RegistrationRepository(context).readBinding() ?: return DeviceConfigResult.Unavailable
        val result = DeviceConfigClient(binding.baseUrl, authFactory(binding), openConnection).fetch()
        if (result is DeviceConfigResult.Fetched) DeviceConfigStore(context).write(binding, result.configuration)
        return result
    }

    internal fun syncConfiguration(context: Context, binding: RegistrationBinding): SyncConfiguration? {
        val configuration = DeviceConfigStore(context).read(binding) ?: return null
        val taxiId = configuration.taxiId ?: return null
        val key = configuration.manifestKey() ?: return null
        val grants = MediaGrantClient(binding.baseUrl, authFactory(binding), openConnection)
        return SyncConfiguration(taxiId = taxiId, trustedManifestKey = key, grantUrl = grants::grantUrl)
    }
}
