package gtads.device.download

import android.content.Context
import android.os.Looper
import gtads.device.manifest.VerifiedMedia
import gtads.device.registration.normalizeServerBaseUrl
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

/** Feste Integritaetsfehler eines Medientransfers, ohne Rohdaten oder Pfade. */
enum class MediaIntegrityFailure { CONTENT_RANGE, TOO_LARGE, HASH, SIZE, INCOMPLETE, METADATA }

/** Ergebnis genau eines Downloadversuchs fuer ein einzelnes Medium (CX-075 / R-902). */
sealed interface MediaDownloadResult {
    /** Datei ist vollstaendig, groessen- und SHA-256-geprueft und atomar benannt. */
    class Completed(val file: File, val sha256: String, val sizeBytes: Long) : MediaDownloadResult

    /** Downloadfreigabe abgelaufen oder abgelehnt; eine neue Freigabe ist noetig. */
    data object GrantExpired : MediaDownloadResult

    /** Voruebergehend nicht moeglich; gueltige Teilbytes bleiben erhalten. */
    data object Retryable : MediaDownloadResult

    /** Server verweigert den Bereich; ohne vollstaendige Datei ist ein Neustart noetig. */
    data object RestartRequired : MediaDownloadResult

    /** Antwort oder Inhalt hat die Integritaetspruefung nicht bestanden; Teildatei verworfen. */
    data class IntegrityFailure(val code: MediaIntegrityFailure) : MediaDownloadResult

    /** Unerwarteter HTTP-Status, insbesondere Weiterleitungen. */
    data class Unexpected(val status: Int) : MediaDownloadResult

    /** Lokal ungueltiger Aufruf, fremde Origin, fehlende Freigabe oder Hauptthread. */
    data object InvalidInput : MediaDownloadResult
}

/**
 * Begrenzter, fortsetzbarer Download genau eines bereits signaturgeprueften
 * Manifest-Mediums (CX-073) ueber die signierte Download-Freigabe aus CX-008.
 *
 * Es gibt keine Manifeststeuerung, keine parallelen Downloads und keine eigene
 * Tokenbeschaffung. Bytes werden streamend mit festem Puffer gelesen. Teil- und
 * Zieldateien liegen im uebergebenen privaten Verzeichnis und tragen nur aus dem
 * validierten SHA-256 sowie der erwarteten Groesse abgeleitete Namen.
 */
class MediaDownloader internal constructor(
    private val directory: File,
    baseUrl: String,
    private val openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
    /** Erlaubter Downloadpfad; App-Updates nutzen /v1/device/app-downloads/ mit derselben Pruefung. */
    private val pathPrefix: String = DOWNLOAD_PATH_PREFIX,
    private val onMainThread: () -> Boolean = { Looper.myLooper() == Looper.getMainLooper() },
) {
    private val baseUrl: String = baseUrl

    /** Produktive Verdrahtung: privates App-Verzeichnis, keine externe Ablage. */
    constructor(
        context: Context,
        baseUrl: String,
        openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
        onMainThread: () -> Boolean = { Looper.myLooper() == Looper.getMainLooper() },
    ) : this(File(context.filesDir, MEDIA_DIRECTORY), baseUrl, openConnection, DOWNLOAD_PATH_PREFIX, onMainThread)

    fun download(grantUrl: String, media: VerifiedMedia): MediaDownloadResult {
        if (onMainThread()) return MediaDownloadResult.InvalidInput
        if (media.sizeBytes <= 0L || media.sizeBytes > MAX_MEDIA_BYTES) return MediaDownloadResult.InvalidInput
        if (!directory.isDirectory && !directory.mkdirs()) return MediaDownloadResult.InvalidInput

        val url = resolveGrant(grantUrl) ?: return MediaDownloadResult.InvalidInput
        val target = targetFile(directory, media)
        if (target.isFile) {
            if (verifyFile(target, media)) return completed(target, media)
            // Ein vorhandener, aber falscher Zieldateiname allein zaehlt nie.
            target.delete()
        }

        val part = partFile(directory, media)
        if (part.isFile && part.length() > media.sizeBytes) part.delete()
        val offset = if (part.isFile) part.length() else 0L

        var connection: HttpURLConnection? = null
        var stream: InputStream? = null
        try {
            val opened = openConnection(url)
            connection = opened
            opened.requestMethod = "GET"
            opened.instanceFollowRedirects = false
            opened.connectTimeout = TIMEOUT_MS
            opened.readTimeout = TIMEOUT_MS
            opened.useCaches = false
            opened.setRequestProperty("X-GT-Ads-Api-Version", API_VERSION)
            opened.setRequestProperty("Accept-Encoding", "identity")
            if (offset > 0L) {
                opened.setRequestProperty("Range", "bytes=$offset-")
                // Nur derselbe starke Inhalt darf fortgesetzt werden (CX-008).
                opened.setRequestProperty("If-Range", "\"${media.sha256}\"")
            }

            val status = opened.responseCode
            when (status) {
                206 -> {
                    if (offset <= 0L) return fail(part, MediaIntegrityFailure.CONTENT_RANGE)
                    val range = parseContentRange(opened.getHeaderField("Content-Range"))
                        ?: return fail(part, MediaIntegrityFailure.CONTENT_RANGE)
                    val expectedLength = media.sizeBytes - offset
                    if (range.start != offset || range.end != media.sizeBytes - 1L ||
                        range.total != media.sizeBytes || range.length != expectedLength
                    ) {
                        return fail(part, MediaIntegrityFailure.CONTENT_RANGE)
                    }
                    val declared = contentLength(opened)
                    if (declared != null && declared != expectedLength) {
                        return fail(part, MediaIntegrityFailure.CONTENT_RANGE)
                    }
                    stream = opened.inputStream
                    copyBody(stream, part, expectedLength, append = true)?.let {
                        return fail(part, it)
                    }
                    return finish(part, target, media)
                }
                200 -> {
                    val declared = contentLength(opened)
                    if (declared != null && declared != media.sizeBytes) {
                        return fail(part, if (declared > media.sizeBytes) {
                            MediaIntegrityFailure.TOO_LARGE
                        } else {
                            MediaIntegrityFailure.INCOMPLETE
                        })
                    }
                    stream = opened.inputStream
                    // HTTP 200 trotz Range: Teildatei vor dem Schreiben auf null.
                    copyBody(stream, part, media.sizeBytes, append = false)?.let {
                        return fail(part, it)
                    }
                    return finish(part, target, media)
                }
                416 -> {
                    // Nur eine nach Groesse und SHA-256 vollstaendig gepruefte Datei
                    // wird akzeptiert; sonst genau ein expliziter Neustartbedarf.
                    if (part.isFile && part.length() == media.sizeBytes && verifyFile(part, media)) {
                        return promote(part, target, media)
                    }
                    part.delete()
                    return MediaDownloadResult.RestartRequired
                }
                401, 403 -> return MediaDownloadResult.GrantExpired
                404 -> return MediaDownloadResult.Retryable
                409 -> return fail(part, MediaIntegrityFailure.METADATA)
                429 -> return MediaDownloadResult.Retryable
                in 500..599 -> return MediaDownloadResult.Retryable
                in 300..399 -> return MediaDownloadResult.Unexpected(status)
                else -> return MediaDownloadResult.Unexpected(status)
            }
        } catch (_: SocketTimeoutException) {
            // Gueltige Teilbytes bleiben fuer einen spaeteren Range-Versuch erhalten.
            return MediaDownloadResult.Retryable
        } catch (_: IOException) {
            return MediaDownloadResult.Retryable
        } finally {
            try {
                stream?.close()
            } catch (_: IOException) {
                // Schliessen darf das Ergebnis nicht veraendern.
            }
            connection?.disconnect()
        }
    }

    /**
     * Liest genau [expected] Bytes streamend. append=false setzt die Datei zuerst
     * auf null. Ein vorzeitiges Ende oder zusaetzliche Bytes sind Integritaetsfehler.
     */
    private fun copyBody(stream: InputStream, part: File, expected: Long, append: Boolean): MediaIntegrityFailure? {
        val output = FileOutputStream(part, append)
        return try {
            val buffer = ByteArray(BUFFER_BYTES)
            var remaining = expected
            while (remaining > 0L) {
                val read = stream.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                if (read < 0) return MediaIntegrityFailure.INCOMPLETE
                if (read == 0) continue
                output.write(buffer, 0, read)
                remaining -= read.toLong()
            }
            // Kein einziges Byte ueber die erwartete Groesse hinaus uebernehmen.
            if (stream.read() >= 0) return MediaIntegrityFailure.TOO_LARGE
            output.flush()
            output.fd.sync()
            null
        } finally {
            try {
                output.close()
            } catch (_: IOException) {
                // Ein Schreibfehler wird oben als IOException behandelt.
            }
        }
    }

    private fun finish(part: File, target: File, media: VerifiedMedia): MediaDownloadResult {
        if (part.length() != media.sizeBytes) return fail(part, MediaIntegrityFailure.SIZE)
        if (!verifyFile(part, media)) return fail(part, MediaIntegrityFailure.HASH)
        return promote(part, target, media)
    }

    /** Nach vollstaendiger Pruefung atomar in die endgueltige Datei umbenennen. */
    private fun promote(part: File, target: File, media: VerifiedMedia): MediaDownloadResult {
        return try {
            Files.move(
                part.toPath(),
                target.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
            completed(target, media)
        } catch (_: AtomicMoveNotSupportedException) {
            try {
                Files.move(part.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
                completed(target, media)
            } catch (_: Exception) {
                MediaDownloadResult.Retryable
            }
        } catch (_: Exception) {
            MediaDownloadResult.Retryable
        }
    }

    private fun completed(file: File, media: VerifiedMedia): MediaDownloadResult =
        MediaDownloadResult.Completed(file, media.sha256, media.sizeBytes)

    private fun fail(part: File, code: MediaIntegrityFailure): MediaDownloadResult {
        part.delete()
        return MediaDownloadResult.IntegrityFailure(code)
    }

    private fun verifyFile(file: File, media: VerifiedMedia): Boolean {
        if (!file.isFile || file.length() != media.sizeBytes) return false
        return try {
            sha256File(file) == media.sha256
        } catch (_: Exception) {
            false
        }
    }

    private fun sha256File(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(BUFFER_BYTES)
        file.inputStream().use { input ->
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                if (read > 0) digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
    }

    private fun contentLength(connection: HttpURLConnection): Long? {
        val raw = connection.getHeaderField("Content-Length")?.trim() ?: return null
        return raw.toLongOrNull()?.takeIf { it >= 0L }
    }

    private fun parseContentRange(header: String?): ByteRange? {
        val match = CONTENT_RANGE.matchEntire(header?.trim() ?: return null) ?: return null
        val start = match.groupValues[1].toLongOrNull() ?: return null
        val end = match.groupValues[2].toLongOrNull() ?: return null
        val total = match.groupValues[3].toLongOrNull() ?: return null
        if (start < 0L || end < start || total <= 0L || end >= total) return null
        return ByteRange(start, end, total)
    }

    /**
     * Nur HTTPS, gleiche Origin wie die konfigurierte Basis und ein Pfad unter
     * [pathPrefix]<id> (Standard /v1/device/downloads/) mit nichtleerem
     * ticket-Query sind zulaessig.
     */
    private fun resolveGrant(raw: String): URL? {
        val normalized = normalizeServerBaseUrl(baseUrl) ?: return null
        return try {
            val base = URL(normalized)
            val grant = URL(raw.trim())
            if (!grant.protocol.equals("https", ignoreCase = true)) return null
            if (!grant.host.equals(base.host, ignoreCase = true)) return null
            if (effectivePort(grant) != effectivePort(base)) return null
            if (grant.userInfo != null || grant.ref != null) return null
            val prefix = (base.path ?: "").trimEnd('/') + pathPrefix
            if (!grant.path.startsWith(prefix)) return null
            val id = grant.path.removePrefix(prefix)
            if (id.isEmpty() || id.contains('/')) return null
            val query = grant.query ?: return null
            if (query.split('&').none { it.startsWith("ticket=") && it.length > "ticket=".length }) return null
            grant
        } catch (_: Exception) {
            null
        }
    }

    private fun effectivePort(url: URL): Int = if (url.port == -1) url.defaultPort else url.port

    private class ByteRange(val start: Long, val end: Long, val total: Long) {
        val length: Long = end - start + 1L
    }

    companion object {
        const val TIMEOUT_MS = 15_000
        /** Gleiche Obergrenze wie Server-Upload und Profilpruefung (L-01). */
        const val MAX_MEDIA_BYTES = 1_000_000_000L
        private const val API_VERSION = "1"
        private const val BUFFER_BYTES = 16 * 1024
        internal const val MEDIA_DIRECTORY = "media-downloads"
        private const val DOWNLOAD_PATH_PREFIX = "/v1/device/downloads/"
        private val CONTENT_RANGE = Regex("bytes (\\d+)-(\\d+)/(\\d+)")

        /** Aus dem validierten Hash und der erwarteten Groesse abgeleiteter Zielname. */
        internal fun targetFile(directory: File, media: VerifiedMedia): File =
            File(directory, "media-${media.sha256}.bin")

        /** Teildatei ist nur fuer denselben Hash und dieselbe erwartete Groesse wiederverwendbar. */
        internal fun partFile(directory: File, media: VerifiedMedia): File =
            File(directory, "media-${media.sha256}-${media.sizeBytes}.part")
    }
}
