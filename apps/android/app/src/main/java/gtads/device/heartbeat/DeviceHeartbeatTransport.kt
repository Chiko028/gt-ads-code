package gtads.device.heartbeat

import android.os.Looper
import gtads.device.auth.DeviceAuthClient
import gtads.device.auth.DeviceAuthResult
import gtads.device.registration.normalizeServerBaseUrl
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import org.json.JSONObject

/**
 * Produktiver Heartbeat-Transport (CX-085 / R-904).
 *
 * Nutzt den vorhandenen Geraetetransport und die vorhandene
 * Geraeteauthentifizierung aus CX-074: der Bearer-Nachweis kommt aus
 * [DeviceAuthClient]; es gibt keine zweite Authentifizierung. Der Aufruf
 * entspricht exakt dem U5-Vertrag POST /v1/device/heartbeat mit den Feldern
 * seq, device_time, app_version und os_version.
 */
class DeviceHeartbeatTransport(
    private val baseUrl: String,
    private val obtainToken: () -> DeviceAuthResult,
    private val openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
    private val onMainThread: () -> Boolean = { Looper.myLooper() == Looper.getMainLooper() },
) : HeartbeatTransport {

    /** Produktive Verdrahtung mit dem bestehenden Geraete-Anmeldeclient. */
    constructor(
        baseUrl: String,
        auth: DeviceAuthClient,
        openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
    ) : this(baseUrl, auth::obtainToken, openConnection)

    override fun send(request: HeartbeatRequest): HeartbeatResult {
        if (onMainThread()) return HeartbeatResult.InvalidInput
        if (!validText(request.appVersion) || !validText(request.osVersion)) {
            return HeartbeatResult.InvalidInput
        }
        if (request.seq < 0L) return HeartbeatResult.InvalidInput
        val target = targetUrl() ?: return HeartbeatResult.InvalidInput
        val body = JSONObject()
            .put("seq", request.seq)
            .put("device_time", HeartbeatRequest.deviceTime(request.deviceTime))
            .put("app_version", request.appVersion)
            .put("os_version", request.osVersion)
            .toString()
            .toByteArray(Charsets.UTF_8)
        val token = when (val auth = obtainToken()) {
            is DeviceAuthResult.Token -> auth.accessToken
            DeviceAuthResult.AuthenticationRequired -> return HeartbeatResult.AuthenticationRequired
            DeviceAuthResult.Unavailable -> return HeartbeatResult.Retryable
            DeviceAuthResult.InvalidInput -> return HeartbeatResult.InvalidInput
        }

        var connection: HttpURLConnection? = null
        var response: InputStream? = null
        try {
            val opened = openConnection(target)
            connection = opened
            opened.requestMethod = "POST"
            opened.doOutput = true
            opened.instanceFollowRedirects = false
            opened.useCaches = false
            opened.connectTimeout = CONNECT_TIMEOUT_MS
            opened.readTimeout = READ_TIMEOUT_MS
            opened.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
            opened.setRequestProperty("Accept-Encoding", "identity")
            opened.setRequestProperty("X-GT-Ads-Api-Version", API_VERSION)
            opened.setRequestProperty("Authorization", "Bearer " + token)
            opened.setFixedLengthStreamingMode(body.size)
            opened.outputStream.use { it.write(body) }

            val status = opened.responseCode
            if (status == 200) {
                response = opened.inputStream
                val bytes = readBounded(response) ?: return HeartbeatResult.Retryable
                return if (parseObject(bytes) != null) HeartbeatResult.Accepted else HeartbeatResult.Retryable
            }
            return when {
                status == 401 || status == 403 -> HeartbeatResult.AuthenticationRequired
                status == 408 || status == 429 || status in 500..599 -> HeartbeatResult.Retryable
                else -> HeartbeatResult.Rejected(status)
            }
        } catch (_: SocketTimeoutException) {
            return HeartbeatResult.Retryable
        } catch (_: IOException) {
            return HeartbeatResult.Retryable
        } finally {
            try {
                response?.close()
            } catch (_: IOException) {
                // Schliessen darf das Ergebnis nicht veraendern.
            }
            connection?.disconnect()
        }
    }

    private fun validText(value: String): Boolean = value.isNotEmpty() && value.length <= 64

    private fun targetUrl(): URL? {
        val normalized = normalizeServerBaseUrl(baseUrl) ?: return null
        return try {
            val base = URL(normalized)
            URL(base.protocol, base.host, base.port, (base.path ?: "") + HEARTBEAT_PATH)
        } catch (_: Exception) {
            null
        }
    }

    private fun parseObject(bytes: ByteArray): JSONObject? = try {
        org.json.JSONTokener(String(bytes, Charsets.UTF_8)).nextValue() as? JSONObject
    } catch (_: Exception) {
        null
    }

    /** Liest hoechstens MAX_RESPONSE_BYTES + 1 Bytes; mehr ergibt keinen Teilbody. */
    private fun readBounded(stream: InputStream?): ByteArray? {
        if (stream == null) return ByteArray(0)
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(4_096)
        var total = 0
        while (true) {
            val read = stream.read(buffer, 0, minOf(buffer.size, MAX_RESPONSE_BYTES + 1 - total))
            if (read < 0) return output.toByteArray()
            total += read
            if (total > MAX_RESPONSE_BYTES) return null
            output.write(buffer, 0, read)
        }
    }

    companion object {
        const val CONNECT_TIMEOUT_MS = 10_000
        const val READ_TIMEOUT_MS = 15_000
        const val MAX_RESPONSE_BYTES = 16_384
        private const val API_VERSION = "1"
        private const val HEARTBEAT_PATH = "/v1/device/heartbeat"
    }
}
