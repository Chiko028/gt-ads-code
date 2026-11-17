package gtads.device.control

import gtads.device.auth.DeviceAuthClient
import gtads.device.auth.DeviceAuthResult
import gtads.device.auth.DeviceHttp
import gtads.device.auth.DeviceHttpResult
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONArray
import org.json.JSONObject

/** Ein Befehl aus GET /v1/device/commands (CX-054): command_id, revision, desired_paused. */
data class WireCommand(val commandId: String, val revision: Long, val desiredPaused: Boolean)

sealed interface CommandFetchResult {
    data class Commands(val items: List<WireCommand>) : CommandFetchResult
    /** 429 oder 503; [afterMs] aus Retry-After, sonst null. */
    data class RetryLater(val afterMs: Long?) : CommandFetchResult
    data object Transient : CommandFetchResult
    data object AuthenticationRequired : CommandFetchResult
    /** 403 device_revoked: dauerhafte Sperre. */
    data object Revoked : CommandFetchResult
    data object Invalid : CommandFetchResult
}

sealed interface AckResult {
    /** 200 status=acknowledged (auch duplicate). */
    data object Confirmed : AckResult
    /** 409: Auftrag unbekannt oder ueberholt; Quittung kann nie mehr gelingen. */
    data object Superseded : AckResult
    data class RetryLater(val afterMs: Long?) : AckResult
    data object Transient : AckResult
    data object AuthenticationRequired : AckResult
    data object Revoked : AckResult
}

/** Abruf und Quittierung; die Produktion nutzt den authentifizierten Geraetetransport (CX-074). */
interface CommandTransport {
    fun fetch(): CommandFetchResult
    fun acknowledge(ack: PendingAcknowledgement): AckResult
}

/**
 * Produktiver Transport: exakt die CX-054-Routen ueber [DeviceHttp] und die
 * vorhandene Challenge/Response-Anmeldung aus [DeviceAuthClient]. Keine eigene
 * Tokenverwaltung; Tokens und Antwortkoerper werden nie protokolliert.
 */
class HttpCommandTransport(
    baseUrl: String,
    private val auth: DeviceAuthClient,
    openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
) : CommandTransport {
    private val http = DeviceHttp(baseUrl, openConnection, TIMEOUT_MS, TIMEOUT_MS)

    override fun fetch(): CommandFetchResult {
        val token = when (val result = auth.obtainToken()) {
            is DeviceAuthResult.Token -> result.accessToken
            DeviceAuthResult.AuthenticationRequired -> return CommandFetchResult.AuthenticationRequired
            DeviceAuthResult.Unavailable -> return CommandFetchResult.Transient
            DeviceAuthResult.InvalidInput -> return CommandFetchResult.Invalid
        }
        val response = when (val r = http.call("GET", COMMANDS_PATH, null, token, null, MAX_BYTES)) {
            is DeviceHttpResult.Response -> r
            DeviceHttpResult.InvalidTarget -> return CommandFetchResult.Invalid
            else -> return CommandFetchResult.Transient
        }
        return when (response.status) {
            200 -> parseCommands(response.body)?.let { CommandFetchResult.Commands(it) } ?: CommandFetchResult.Invalid
            401 -> CommandFetchResult.AuthenticationRequired
            403 -> if (isRevoked(response.body)) CommandFetchResult.Revoked else CommandFetchResult.AuthenticationRequired
            429, 503 -> CommandFetchResult.RetryLater(response.retryAfterSeconds?.times(1000L))
            in 500..599 -> CommandFetchResult.Transient
            else -> CommandFetchResult.Invalid
        }
    }

    override fun acknowledge(ack: PendingAcknowledgement): AckResult {
        val token = when (val result = auth.obtainToken()) {
            is DeviceAuthResult.Token -> result.accessToken
            DeviceAuthResult.AuthenticationRequired -> return AckResult.AuthenticationRequired
            else -> return AckResult.Transient
        }
        val body = JSONObject().put("command_id", ack.commandId).put("revision", ack.revision)
            .toString().toByteArray(Charsets.UTF_8)
        val response = when (val r = http.call("POST", ACK_PATH, body, token, null, MAX_BYTES)) {
            is DeviceHttpResult.Response -> r
            else -> return AckResult.Transient
        }
        return when (response.status) {
            200 -> if (isAcknowledged(response.body, ack)) AckResult.Confirmed else AckResult.Transient
            409 -> AckResult.Superseded
            401 -> AckResult.AuthenticationRequired
            403 -> if (isRevoked(response.body)) AckResult.Revoked else AckResult.AuthenticationRequired
            429, 503 -> AckResult.RetryLater(response.retryAfterSeconds?.times(1000L))
            else -> AckResult.Transient
        }
    }

    companion object {
        const val COMMANDS_PATH = "/v1/device/commands"
        const val ACK_PATH = "/v1/device/commands/ack"
        private const val TIMEOUT_MS = 15_000
        private const val MAX_BYTES = 64 * 1024

        internal fun parseCommands(bytes: ByteArray): List<WireCommand>? = try {
            val json = JSONObject(String(bytes, Charsets.UTF_8))
            val list = json.get("commands") as? JSONArray
            if (list == null) {
                null
            } else {
                (0 until list.length()).map { index ->
                    val item = list.getJSONObject(index)
                    val revision = when (val raw = item.get("revision")) {
                        is Int -> raw.toLong()
                        is Long -> raw
                        else -> throw IllegalArgumentException()
                    }
                    WireCommand(item.getString("command_id"), revision, item.get("desired_paused") as Boolean)
                }
            }
        } catch (_: Exception) {
            null
        }

        private fun isAcknowledged(bytes: ByteArray, ack: PendingAcknowledgement): Boolean = try {
            val json = JSONObject(String(bytes, Charsets.UTF_8))
            json.optString("status") == "acknowledged" &&
                json.optString("command_id").equals(ack.commandId, ignoreCase = true)
        } catch (_: Exception) {
            false
        }

        private fun isRevoked(bytes: ByteArray): Boolean = try {
            val error = JSONObject(String(bytes, Charsets.UTF_8)).opt("error")
            val code = if (error is JSONObject) error.optString("code") else error?.toString()
            code == "device_revoked"
        } catch (_: Exception) {
            false
        }
    }
}
