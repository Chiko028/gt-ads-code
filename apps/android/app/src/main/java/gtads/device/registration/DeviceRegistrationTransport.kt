package gtads.device.registration

import android.os.Looper
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL

/** Neutrales Transportergebnis; kein Registrierungserfolg und keine Geraeteidentitaet. */
sealed interface TransportResult {
    data class Response(val status: Int, val body: ByteArray) : TransportResult

    data class Failure(val code: ErrorCode) : TransportResult
}

/** Lokale Fehlercodes ohne Ursachen oder rohe Fehlermeldungen. */
enum class ErrorCode {
    INVALID_INPUT,
    MAIN_THREAD,
    TIMEOUT,
    NETWORK,
    RESPONSE_TOO_LARGE,
}

/**
 * Begrenzter HTTPS-Transport fuer POST /v1/device/register. Die Anfragebytes
 * muessen bereits serialisiert sein; dieser Typ interpretiert keine Antwort.
 */
class DeviceRegistrationTransport(
    private val baseUrl: String,
    private val openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
    private val onMainThread: () -> Boolean = { Looper.myLooper() == Looper.getMainLooper() },
) {
    fun send(requestBytes: ByteArray, apiVersion: String = API_VERSION): TransportResult {
        if (onMainThread()) {
            return TransportResult.Failure(ErrorCode.MAIN_THREAD)
        }
        if (apiVersion.trim() != API_VERSION) {
            return TransportResult.Failure(ErrorCode.INVALID_INPUT)
        }
        val target = targetUrl() ?: return TransportResult.Failure(ErrorCode.INVALID_INPUT)

        var connection: HttpURLConnection? = null
        var responseStream: InputStream? = null
        try {
            val opened = openConnection(target)
            connection = opened
            opened.requestMethod = "POST"
            opened.doOutput = true
            opened.instanceFollowRedirects = false
            opened.connectTimeout = CONNECT_TIMEOUT_MS
            opened.readTimeout = READ_TIMEOUT_MS
            opened.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
            opened.setRequestProperty("X-GT-Ads-Api-Version", API_VERSION)
            // Feste Laenge statt gepufferter Body: Der Android-HTTP-Stack darf einen
            // Streaming-Request bei Verbindungsfehlern nicht still wiederholen. Der
            // Modus muss vor dem Oeffnen des Ausgabestreams gesetzt sein.
            opened.setFixedLengthStreamingMode(requestBytes.size)
            opened.outputStream.use { it.write(requestBytes) }

            val status = opened.responseCode
            responseStream = if (status in 200..299) opened.inputStream else opened.errorStream
            val body = readBounded(responseStream)
                ?: return TransportResult.Failure(ErrorCode.RESPONSE_TOO_LARGE)
            return TransportResult.Response(status, body)
        } catch (_: SocketTimeoutException) {
            return TransportResult.Failure(ErrorCode.TIMEOUT)
        } catch (_: IOException) {
            return TransportResult.Failure(ErrorCode.NETWORK)
        } finally {
            try {
                responseStream?.close()
            } catch (_: IOException) {
                // Schliessen darf das Ergebnis nicht veraendern.
            }
            connection?.disconnect()
        }
    }

    /** Liest hoechstens MAX_RESPONSE_BYTES + 1 Bytes; mehr ergibt keinen Teilbody. */
    private fun readBounded(stream: InputStream?): ByteArray? {
        if (stream == null) {
            return ByteArray(0)
        }
        try {
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(READ_BUFFER_BYTES)
            var total = 0
            while (total <= MAX_RESPONSE_BYTES) {
                val remaining = MAX_RESPONSE_BYTES + 1 - total
                val read = stream.read(buffer, 0, minOf(buffer.size, remaining))
                if (read < 0) {
                    return output.toByteArray()
                }
                total += read
                if (total > MAX_RESPONSE_BYTES) {
                    return null
                }
                output.write(buffer, 0, read)
            }
            return null
        } finally {
            try {
                stream.close()
            } catch (_: IOException) {
                // Schliessen darf das Ergebnis nicht veraendern.
            }
        }
    }

    /** Prueft die Basisadresse und erhaelt deren Pfad beim Anhaengen des Endpunkts. */
    private fun targetUrl(): URL? {
        val base = try {
            URL(baseUrl)
        } catch (_: Exception) {
            return null
        }
        if (!base.protocol.equals("https", ignoreCase = true)) return null
        if (base.host.isNullOrBlank()) return null
        if (base.userInfo != null || base.query != null || base.ref != null) return null
        val path = base.path ?: ""
        val prefix = if (path.isEmpty() || path == "/") "" else path.trimEnd('/')
        return try {
            URL(base.protocol, base.host, base.port, prefix + REGISTER_PATH)
        } catch (_: Exception) {
            null
        }
    }

    companion object {
        const val CONNECT_TIMEOUT_MS = 10_000
        const val READ_TIMEOUT_MS = 15_000
        const val MAX_RESPONSE_BYTES = 262_144
        private const val READ_BUFFER_BYTES = 8_192
        private const val API_VERSION = "1"
        private const val REGISTER_PATH = "/v1/device/register"
    }
}
