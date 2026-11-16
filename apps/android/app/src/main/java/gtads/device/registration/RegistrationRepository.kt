package gtads.device.registration

import android.content.Context
import android.util.AtomicFile
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import org.json.JSONObject

/** Lesbarer Zustand fuer CX-072; enthaelt nie Code, Token oder Schluessel. */
sealed interface RegistrationState {
    data object NotRegistered : RegistrationState
    data object Registering : RegistrationState
    data class Registered(val deviceId: String, val baseUrl: String) : RegistrationState
    data object Unknown : RegistrationState
    data class Failed(val reason: RegistrationFailure) : RegistrationState
}

/** Feste oeffentliche Fehlerkategorien ohne Ursachen oder Rohtexte. */
enum class RegistrationFailure { INVALID_BASE_URL, IDENTITY_UNAVAILABLE, STORAGE_UNAVAILABLE }

internal const val REGISTRATION_FILE_NAME = "device-registration.json"

/**
 * Privater AtomicFile-Speicher unter noBackupFilesDir. Es gibt keine Reset-,
 * Serverwechsel- oder Ueberschreibfunktion; eine bestehende Bindung bleibt.
 */
class RegistrationRepository internal constructor(
    private val file: File,
    private val openAtomic: (File) -> AtomicFile = ::AtomicFile,
) {
    constructor(context: Context) : this(File(context.noBackupFilesDir, REGISTRATION_FILE_NAME))

    fun read(): RegistrationState {
        val json = readJson() ?: return if (file.exists()) {
            RegistrationState.Unknown
        } else {
            RegistrationState.NotRegistered
        }
        return when (json.optString(KEY_STATUS)) {
            STATUS_REGISTERED -> when {
                json.optString(KEY_DEVICE_ID).isBlank() -> RegistrationState.Unknown
                json.optString(KEY_BASE_URL).isBlank() -> RegistrationState.Unknown
                else -> RegistrationState.Registered(
                    json.optString(KEY_DEVICE_ID),
                    json.optString(KEY_BASE_URL),
                )
            }
            else -> RegistrationState.Unknown
        }
    }

    fun writeMarker(baseUrl: String): Boolean = write(
        JSONObject()
            .put(KEY_VERSION, VERSION)
            .put(KEY_STATUS, STATUS_UNKNOWN)
            .put(KEY_BASE_URL, baseUrl),
    )

    fun writeRegistered(deviceId: String, baseUrl: String): Boolean = write(
        JSONObject()
            .put(KEY_VERSION, VERSION)
            .put(KEY_STATUS, STATUS_REGISTERED)
            .put(KEY_DEVICE_ID, deviceId)
            .put(KEY_BASE_URL, baseUrl),
    )

    /** Entfernt nur einen lesbaren offenen Marker; nie eine Bindung oder kaputte Datei. */
    fun clearMarker(): Boolean {
        val json = readJson() ?: return !file.exists()
        if (json.optString(KEY_STATUS) != STATUS_UNKNOWN) return false
        return try {
            file.delete()
        } catch (_: Exception) {
            false
        }
    }

    private fun readJson(): JSONObject? {
        val bytes = try {
            openAtomic(file).readFully()
        } catch (_: FileNotFoundException) {
            return null
        } catch (_: Exception) {
            return null
        }
        return try {
            JSONObject(String(bytes, Charsets.UTF_8))
        } catch (_: Exception) {
            null
        }
    }

    private fun write(json: JSONObject): Boolean {
        val atomic = try {
            openAtomic(file)
        } catch (_: Exception) {
            return false
        }
        var stream: FileOutputStream? = null
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
                    // Der vorhandene Marker bleibt unveraendert.
                }
            }
            false
        }
    }

    private companion object {
        const val VERSION = 1
        const val KEY_VERSION = "v"
        const val KEY_STATUS = "status"
        const val KEY_DEVICE_ID = "device_id"
        const val KEY_BASE_URL = "base_url"
        const val STATUS_REGISTERED = "registered"
        const val STATUS_UNKNOWN = "unknown"
    }
}
