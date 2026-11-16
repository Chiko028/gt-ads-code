package gtads.device.registration

import android.util.AtomicFile
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.net.URL
import org.json.JSONObject

internal const val SERVER_CONFIG_FILE_NAME = "device-server-config.json"

/**
 * Persistente Serverkonfiguration. [baseUrl] ist die normalisierte Adresse,
 * [generation] steigt bei jedem Wechsel der Adresse und bleibt sonst stabil.
 */
data class ServerConfiguration(val baseUrl: String, val generation: Long)

/** Gespeicherte Bindung einer erfolgreichen Registrierung. Generation 0 = Altbestand. */
data class RegistrationBinding(
    val deviceId: String,
    val baseUrl: String,
    val generation: Long,
)

/**
 * Eine prozessweite Sperre fuer Konfigurationswechsel und Registrierungs-
 * abschluesse. Pruefentscheidung und Speicherung laufen unter demselben
 * Monitor, damit eine parallele Adressaenderung nicht dazwischenliegt.
 */
internal object RegistrationSerialization {
    val lock = Any()
}

/**
 * Normalisiert eine Basisadresse mit denselben Regeln wie der Transport:
 * nur HTTPS, Host vorhanden, keine Benutzerinfo/Query/Fragment; der Pfad
 * verliert hoechstens abschliessende Schraegstriche.
 */
internal fun normalizeServerBaseUrl(raw: String): String? {
    val url = try {
        URL(raw.trim())
    } catch (_: Exception) {
        return null
    }
    if (!url.protocol.equals("https", ignoreCase = true)) return null
    val host = url.host
    if (host.isNullOrBlank()) return null
    if (url.userInfo != null || url.query != null || url.ref != null) return null
    val path = url.path ?: ""
    val prefix = if (path.isEmpty() || path == "/") "" else path.trimEnd('/')
    return try {
        URL(url.protocol.lowercase(), host.lowercase(), url.port, prefix).toString()
    } catch (_: Exception) {
        null
    }
}

/** Persistente Generation der Serverkonfiguration; nie der Registrierungscode. */
interface ServerConfigurationStore {
    fun current(): ServerConfiguration?

    fun activate(normalizedBaseUrl: String): ServerConfiguration?
}

/** AtomicFile-Speicher fuer normalisierte Adresse und Generation. */
internal class FileServerConfigurationStore(
    private val file: File,
    private val openAtomic: (File) -> AtomicFile = ::AtomicFile,
) : ServerConfigurationStore {
    override fun current(): ServerConfiguration? = synchronized(RegistrationSerialization.lock) {
        readConfiguration()
    }

    override fun activate(normalizedBaseUrl: String): ServerConfiguration? =
        synchronized(RegistrationSerialization.lock) {
            if (normalizeServerBaseUrl(normalizedBaseUrl) != normalizedBaseUrl) return null
            val existing = readConfiguration()
            if (existing != null && existing.baseUrl == normalizedBaseUrl) return existing
            val next = ServerConfiguration(
                normalizedBaseUrl,
                (existing?.generation ?: 0L) + 1L,
            )
            if (writeConfiguration(next)) next else null
        }

    private fun readConfiguration(): ServerConfiguration? {
        val bytes = try {
            openAtomic(file).readFully()
        } catch (_: FileNotFoundException) {
            return null
        } catch (_: Exception) {
            return null
        }
        val json = try {
            JSONObject(String(bytes, Charsets.UTF_8))
        } catch (_: Exception) {
            return null
        }
        if (json.optInt(KEY_VERSION, 0) != VERSION) return null
        val url = json.optString(KEY_BASE_URL)
        val generation = json.optLong(KEY_GENERATION, 0L)
        if (url.isBlank() || generation < 1L) return null
        if (normalizeServerBaseUrl(url) != url) return null
        return ServerConfiguration(url, generation)
    }

    private fun writeConfiguration(configuration: ServerConfiguration): Boolean {
        val atomic = try {
            openAtomic(file)
        } catch (_: Exception) {
            return false
        }
        var stream: FileOutputStream? = null
        val json = JSONObject()
            .put(KEY_VERSION, VERSION)
            .put(KEY_BASE_URL, configuration.baseUrl)
            .put(KEY_GENERATION, configuration.generation)
        return try {
            val opened = atomic.startWrite()
            stream = opened
            opened.write(json.toString().replace("\\/", "/").toByteArray(Charsets.UTF_8))
            opened.flush()
            atomic.finishWrite(opened)
            true
        } catch (_: Exception) {
            stream?.let {
                try {
                    atomic.failWrite(it)
                } catch (_: Exception) {
                    // Der vorherige Stand bleibt unveraendert.
                }
            }
            false
        }
    }

    private companion object {
        const val VERSION = 1
        const val KEY_VERSION = "v"
        const val KEY_BASE_URL = "base_url"
        const val KEY_GENERATION = "generation"
    }
}
