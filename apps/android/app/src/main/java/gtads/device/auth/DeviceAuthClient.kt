package gtads.device.auth

import android.os.Looper
import android.util.Base64
import gtads.device.registration.normalizeServerBaseUrl
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL

/** Ergebnis eines Geraete-HTTP-Aufrufs ohne Rohantworten in Fehlerfaellen. */
internal sealed interface DeviceHttpResult {
    class Response(val status: Int, val body: ByteArray, val etag: String?) : DeviceHttpResult
    data object Timeout : DeviceHttpResult
    data object Network : DeviceHttpResult
    data object TooLarge : DeviceHttpResult
    data object InvalidTarget : DeviceHttpResult
}

/**
 * Gemeinsamer, begrenzter Geraete-HTTP-Aufruf (Konventionen wie DeviceRegistrationTransport):
 * feste Zeitgrenzen, keine automatischen Weiterleitungen, Antwort hoechstens maxBytes
 * (nach transparenter Dekomprimierung gezaehlt, zusaetzlich Accept-Encoding: identity).
 */
internal class DeviceHttp(
    private val baseUrl: String,
    private val openConnection: (URL) -> HttpURLConnection,
    private val connectTimeoutMs: Int,
    private val readTimeoutMs: Int,
) {
    fun call(method: String, path: String, jsonBody: ByteArray?, bearer: String?, ifNoneMatch: String?, maxBytes: Int): DeviceHttpResult {
        val target = target(path) ?: return DeviceHttpResult.InvalidTarget
        var connection: HttpURLConnection? = null
        var stream: InputStream? = null
        try {
            val opened = openConnection(target)
            connection = opened
            opened.requestMethod = method
            opened.instanceFollowRedirects = false
            opened.connectTimeout = connectTimeoutMs
            opened.readTimeout = readTimeoutMs
            opened.useCaches = false
            opened.setRequestProperty("X-GT-Ads-Api-Version", API_VERSION)
            opened.setRequestProperty("Accept-Encoding", "identity")
            if (bearer != null) opened.setRequestProperty("Authorization", "Bearer $bearer")
            if (ifNoneMatch != null) opened.setRequestProperty("If-None-Match", ifNoneMatch)
            if (jsonBody != null) {
                opened.doOutput = true
                opened.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
                opened.setFixedLengthStreamingMode(jsonBody.size)
                opened.outputStream.use { it.write(jsonBody) }
            }
            val status = opened.responseCode
            stream = if (status in 200..299) opened.inputStream else opened.errorStream
            val body = readBounded(stream, maxBytes) ?: return DeviceHttpResult.TooLarge
            return DeviceHttpResult.Response(status, body, opened.getHeaderField("ETag"))
        } catch (_: SocketTimeoutException) {
            return DeviceHttpResult.Timeout
        } catch (_: IOException) {
            return DeviceHttpResult.Network
        } finally {
            try {
                stream?.close()
            } catch (_: IOException) {
                // Schliessen darf das Ergebnis nicht veraendern.
            }
            connection?.disconnect()
        }
    }

    private fun readBounded(stream: InputStream?, maxBytes: Int): ByteArray? {
        if (stream == null) return ByteArray(0)
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8_192)
        var total = 0
        while (true) {
            val read = stream.read(buffer, 0, minOf(buffer.size, maxBytes + 1 - total))
            if (read < 0) return output.toByteArray()
            total += read
            if (total > maxBytes) return null
            output.write(buffer, 0, read)
        }
    }

    private fun target(path: String): URL? {
        val normalized = normalizeServerBaseUrl(baseUrl) ?: return null
        return try {
            val base = URL(normalized)
            URL(base.protocol, base.host, base.port, (base.path ?: "") + path)
        } catch (_: Exception) {
            null
        }
    }

    companion object {
        const val API_VERSION = "1"
    }
}

/** Ergebnis der Geraeteanmeldung; Fehler enthalten weder Nonce, Signatur noch Token. */
sealed interface DeviceAuthResult {
    class Token(val accessToken: String) : DeviceAuthResult {
        override fun toString(): String = "Token(***)"
    }
    /** Server lehnt die Identitaet ab (401/403, z. B. widerrufen oder Signatur ungueltig). */
    data object AuthenticationRequired : DeviceAuthResult
    /** Voruebergehend (Zeitlimit, Netz, 429/5xx, unlesbare Antwort). */
    data object Unavailable : DeviceAuthResult
    /** Lokal nicht moeglich (Hauptthread, ungueltige Basis-URL, Identitaet nicht nutzbar). */
    data object InvalidInput : DeviceAuthResult
}

/**
 * Challenge-/Response-Anmeldung nach API-VERTRAG.md Abschnitt 3 mit der vorhandenen
 * Geraeteidentitaet (CX-069 bis CX-071):
 * POST /v1/device/auth/challenge {device_id} -> {nonce}
 * Signatur ueber "gt-ads-auth-v1\n<device_id>\n<nonce>" (SHA256withECDSA, DER, Base64)
 * POST /v1/device/auth/token {device_id, nonce, signature} -> {access_token}
 * Keine Wiederholung, keine Speicherung, keine Protokollierung von Nachweisen.
 */
class DeviceAuthClient(
    baseUrl: String,
    private val deviceId: String,
    private val sign: (ByteArray) -> ByteArray,
    openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
    private val onMainThread: () -> Boolean = { Looper.myLooper() == Looper.getMainLooper() },
) {
    private val http = DeviceHttp(baseUrl, openConnection, TIMEOUT_MS, TIMEOUT_MS)

    fun obtainToken(): DeviceAuthResult {
        if (onMainThread() || deviceId.isBlank()) return DeviceAuthResult.InvalidInput
        val challengeBody = JSONObject().put("device_id", deviceId).toString().toByteArray(Charsets.UTF_8)
        val challenge = http.call("POST", CHALLENGE_PATH, challengeBody, null, null, MAX_RESPONSE_BYTES)
        val nonce = when (val outcome = interpret(challenge)) {
            is JSONObject -> (outcome.opt("nonce") as? String)?.takeIf { it.isNotEmpty() }
                ?: return DeviceAuthResult.Unavailable
            else -> return outcome as DeviceAuthResult
        }
        val message = "$MESSAGE_PREFIX\n$deviceId\n$nonce".toByteArray(Charsets.UTF_8)
        val signature = try {
            Base64.encodeToString(sign(message), Base64.NO_WRAP)
        } catch (_: Exception) {
            return DeviceAuthResult.InvalidInput
        }
        val tokenBody = JSONObject().put("device_id", deviceId).put("nonce", nonce).put("signature", signature)
            .toString().toByteArray(Charsets.UTF_8)
        return when (val outcome = interpret(http.call("POST", TOKEN_PATH, tokenBody, null, null, MAX_RESPONSE_BYTES))) {
            is JSONObject -> {
                val token = outcome.opt("access_token") as? String
                val type = outcome.opt("token_type") as? String
                if (token.isNullOrEmpty() || token.any(Char::isWhitespace) || !type.equals("Bearer", ignoreCase = true)) {
                    DeviceAuthResult.Unavailable
                } else {
                    DeviceAuthResult.Token(token)
                }
            }
            else -> outcome as DeviceAuthResult
        }
    }

    /** 200 mit JSON-Objekt -> Objekt; sonst das passende Fehlerergebnis. */
    private fun interpret(result: DeviceHttpResult): Any = when (result) {
        is DeviceHttpResult.Response -> when {
            result.status == 200 -> parseObject(result.body) ?: DeviceAuthResult.Unavailable
            result.status == 401 || result.status == 403 -> DeviceAuthResult.AuthenticationRequired
            else -> DeviceAuthResult.Unavailable
        }
        DeviceHttpResult.InvalidTarget -> DeviceAuthResult.InvalidInput
        else -> DeviceAuthResult.Unavailable
    }

    private fun parseObject(bytes: ByteArray): JSONObject? = try {
        JSONTokener(String(bytes, Charsets.UTF_8)).nextValue() as? JSONObject
    } catch (_: JSONException) {
        null
    }

    companion object {
        const val TIMEOUT_MS = 15_000
        const val MAX_RESPONSE_BYTES = 16_384
        private const val MESSAGE_PREFIX = "gt-ads-auth-v1"
        private const val CHALLENGE_PATH = "/v1/device/auth/challenge"
        private const val TOKEN_PATH = "/v1/device/auth/token"
    }
}
