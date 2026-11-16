package gtads.device.manifest

import android.content.Context
import android.util.AtomicFile
import gtads.device.download.MediaDownloader
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.security.PublicKey
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject

/** Feste, nutzdatenfreie Fehlercodes des lokalen Manifeststands (CX-076 / R-902). */
enum class ManifestStoreFailure {
    /** Ein referenziertes Medium fehlt oder hat die falsche Groesse. */
    MEDIA_MISSING,

    /** Ein referenziertes Medium hat den falschen SHA-256. */
    MEDIA_CORRUPT,

    /** Manifestinhalt oder ETag ist fuer die Aktivierung unbrauchbar. */
    INVALID_INPUT,

    /** Der aktive Zeiger ist nicht lesbar oder inkonsistent. */
    POINTER_CORRUPT,

    /** Das referenzierte Artefakt fehlt, ist veraendert oder besteht die Pruefung nicht mehr. */
    ARTIFACT_INVALID,

    /** Schreiben im privaten App-Speicher ist fehlgeschlagen; bisheriger Stand bleibt. */
    STORAGE,
}

/**
 * Unveraenderlicher Schnappschuss des aktiven Stands. Leser erhalten nie eine
 * Mischung zweier Versionen; jeder Bytezugriff liefert eine Kopie.
 */
class ActiveManifest internal constructor(
    private val artifactBytes: ByteArray,
    val artifactSha256: String,
    val etag: String,
    media: List<VerifiedMedia>,
) {
    val media: List<VerifiedMedia> = java.util.Collections.unmodifiableList(media.toList())
    fun bytes(): ByteArray = artifactBytes.copyOf()
}

sealed interface ManifestActivation {
    /** Neuer Stand ist atomar veroeffentlicht. */
    class Activated(val active: ActiveManifest) : ManifestActivation

    /** Identisches Artefakt ist bereits aktiv; keine neue Aktivierung. */
    data object Unchanged : ManifestActivation

    /** Aktivierung abgelehnt; der bisherige Stand ist unveraendert. */
    data class Rejected(val code: ManifestStoreFailure) : ManifestActivation
}

sealed interface ManifestLoad {
    class Active(val active: ActiveManifest) : ManifestLoad

    /** Es wurde noch nie ein Stand veroeffentlicht. */
    data object Empty : ManifestLoad

    /** Kein aktiver Stand; fester lokaler Fehler statt Auswahl einer beliebigen Datei. */
    data class Failed(val code: ManifestStoreFailure) : ManifestLoad
}

/**
 * Lokales Repository fuer gepruefte Manifest-Artefakte (CX-076).
 *
 * Artefakte werden unveraendert und hashadressiert unter `artifacts/` abgelegt
 * und nie ueberschrieben. Aktiv ist ausschliesslich, was der kleine Zeiger
 * `active.json` referenziert; er wird ueber [AtomicFile] ersetzt und enthaelt
 * Artefakt-Hash, ETag und Medienreferenzen gemeinsam, sodass sie stets
 * zusammenpassen. Vor jeder Aktivierung werden alle referenzierten Medien auf
 * Existenz, Groesse und SHA-256 geprueft. Alte Medien werden nicht geloescht.
 * Kein HTTP, kein Player, keine Hintergrundarbeit, keine Versionsordnung.
 */
class ManifestRepository internal constructor(
    private val storeDirectory: File,
    private val mediaDirectory: File,
    private val trustedPublicKey: PublicKey,
    private val expectedTaxiId: String,
    private val beforePointerSwap: () -> Unit = {},
) {
    /** Produktive Verdrahtung: private App-Dateien, Medien aus dem CX-075-Verzeichnis. */
    constructor(context: Context, trustedPublicKey: PublicKey, expectedTaxiId: String) : this(
        File(context.filesDir, STORE_DIRECTORY),
        File(context.filesDir, MediaDownloader.MEDIA_DIRECTORY),
        trustedPublicKey,
        expectedTaxiId,
    )

    private val lock = Any()
    private val pointer = AtomicFile(File(storeDirectory, POINTER_FILE))
    private val artifactDirectory = File(storeDirectory, ARTIFACT_DIRECTORY)

    @Volatile
    private var current: ActiveManifest? = null

    /** Aktueller Schnappschuss oder null, solange kein gueltiger Stand geladen/aktiviert ist. */
    fun active(): ActiveManifest? = current

    /**
     * Laedt beim Start ausschliesslich den atomar veroeffentlichten Zeiger und
     * prueft das referenzierte Artefakt (CX-073) sowie dessen Medien erneut.
     * Unreferenzierte Kandidaten werden nie als aktiv interpretiert.
     */
    fun load(): ManifestLoad = synchronized(lock) {
        current = null
        val record = try {
            parsePointer(pointer.readFully())
        } catch (_: java.io.FileNotFoundException) {
            return ManifestLoad.Empty
        } catch (_: Exception) {
            null
        } ?: return ManifestLoad.Failed(ManifestStoreFailure.POINTER_CORRUPT)

        val artifactFile = artifactFile(record.artifactSha256)
        val bytes = try {
            if (!artifactFile.isFile || artifactFile.length() > MAX_ARTIFACT_BYTES) null else artifactFile.readBytes()
        } catch (_: IOException) {
            null
        } ?: return ManifestLoad.Failed(ManifestStoreFailure.ARTIFACT_INVALID)
        if (sha256Hex(bytes) != record.artifactSha256) return ManifestLoad.Failed(ManifestStoreFailure.ARTIFACT_INVALID)
        val verified = verifyManifest(bytes, trustedPublicKey, expectedTaxiId) as? ManifestVerification.Verified
            ?: return ManifestLoad.Failed(ManifestStoreFailure.ARTIFACT_INVALID)
        val media = mediaOf(verified) ?: return ManifestLoad.Failed(ManifestStoreFailure.ARTIFACT_INVALID)
        if (!sameMedia(media, record.media)) return ManifestLoad.Failed(ManifestStoreFailure.POINTER_CORRUPT)
        checkMedia(media)?.let { return ManifestLoad.Failed(it) }

        val snapshot = ActiveManifest(bytes, record.artifactSha256, record.etag, media)
        current = snapshot
        ManifestLoad.Active(snapshot)
    }

    /**
     * Aktiviert ein geprueftes Artefakt mit seinem ETag, sobald saemtliche
     * referenzierten Medien vollstaendig vorliegen. Aktivierungen sind im
     * App-Prozess serialisiert; jeder Fehler laesst den bisherigen Stand stehen.
     */
    fun activate(manifest: ManifestVerification.Verified, etag: String): ManifestActivation = synchronized(lock) {
        if (!validEtag(etag)) return ManifestActivation.Rejected(ManifestStoreFailure.INVALID_INPUT)
        val bytes = manifest.bytes()
        val artifactSha256 = sha256Hex(bytes)
        val active = current
        if (active != null && active.artifactSha256 == artifactSha256) return ManifestActivation.Unchanged

        val media = mediaOf(manifest) ?: return ManifestActivation.Rejected(ManifestStoreFailure.INVALID_INPUT)
        checkMedia(media)?.let { return ManifestActivation.Rejected(it) }

        try {
            storeArtifact(artifactSha256, bytes)
        } catch (_: Exception) {
            return ManifestActivation.Rejected(ManifestStoreFailure.STORAGE)
        }

        val record = pointerJson(artifactSha256, etag, media).toByteArray(Charsets.UTF_8)
        var stream: FileOutputStream? = null
        try {
            storeDirectory.mkdirs()
            stream = pointer.startWrite()
            stream.write(record)
            beforePointerSwap()
            pointer.finishWrite(stream)
            stream = null
        } catch (_: Exception) {
            stream?.let { pointer.failWrite(it) }
            return ManifestActivation.Rejected(ManifestStoreFailure.STORAGE)
        }

        val snapshot = ActiveManifest(bytes, artifactSha256, etag, media)
        current = snapshot
        ManifestActivation.Activated(snapshot)
    }

    /** Unveraenderliches, hashadressiertes Artefakt; vorhandene gueltige Datei bleibt unberuehrt. */
    private fun storeArtifact(artifactSha256: String, bytes: ByteArray) {
        if (!artifactDirectory.isDirectory && !artifactDirectory.mkdirs()) throw IOException("store")
        val target = artifactFile(artifactSha256)
        if (target.isFile && target.length() == bytes.size.toLong() && sha256Hex(target.readBytes()) == artifactSha256) return
        val temp = File(artifactDirectory, "manifest-$artifactSha256.tmp")
        FileOutputStream(temp, false).use { out ->
            out.write(bytes)
            out.flush()
            out.fd.sync()
        }
        try {
            Files.move(temp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(temp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    }

    private fun checkMedia(media: List<VerifiedMedia>): ManifestStoreFailure? {
        for (item in media) {
            val file = MediaDownloader.targetFile(mediaDirectory, item)
            if (!file.isFile || file.length() != item.sizeBytes) return ManifestStoreFailure.MEDIA_MISSING
            val hash = try {
                sha256File(file)
            } catch (_: Exception) {
                return ManifestStoreFailure.MEDIA_MISSING
            }
            if (hash != item.sha256) return ManifestStoreFailure.MEDIA_CORRUPT
        }
        return null
    }

    private fun artifactFile(artifactSha256: String): File = File(artifactDirectory, "manifest-$artifactSha256.json")

    private class PointerRecord(val artifactSha256: String, val etag: String, val media: List<Pair<String, Long>>)

    private fun parsePointer(bytes: ByteArray): PointerRecord? {
        if (bytes.size > MAX_POINTER_BYTES) return null
        val json = JSONObject(String(bytes, Charsets.UTF_8))
        if (json.length() != 4 || json.opt("schemaVersion") != POINTER_SCHEMA) return null
        val artifact = json.opt("artifactSha256") as? String ?: return null
        val etag = json.opt("etag") as? String ?: return null
        val list = json.opt("media") as? JSONArray ?: return null
        if (!SHA256_PATTERN.matches(artifact) || !validEtag(etag)) return null
        val media = ArrayList<Pair<String, Long>>()
        for (index in 0 until list.length()) {
            val entry = list.opt(index) as? JSONObject ?: return null
            val sha = entry.opt("sha256") as? String ?: return null
            val size = when (val raw = entry.opt("sizeBytes")) { is Int -> raw.toLong(); is Long -> raw; else -> return null }
            if (!SHA256_PATTERN.matches(sha) || size <= 0L) return null
            media.add(sha to size)
        }
        return PointerRecord(artifact, etag, media)
    }

    private fun pointerJson(artifactSha256: String, etag: String, media: List<VerifiedMedia>): String {
        val list = JSONArray()
        media.forEach { list.put(JSONObject().put("sha256", it.sha256).put("sizeBytes", it.sizeBytes)) }
        return JSONObject()
            .put("schemaVersion", POINTER_SCHEMA)
            .put("artifactSha256", artifactSha256)
            .put("etag", etag)
            .put("media", list)
            .toString()
    }

    private fun sameMedia(media: List<VerifiedMedia>, recorded: List<Pair<String, Long>>): Boolean =
        media.map { it.sha256 to it.sizeBytes } == recorded

    companion object {
        internal const val STORE_DIRECTORY = "manifest-store"
        private const val ARTIFACT_DIRECTORY = "artifacts"
        private const val POINTER_FILE = "active.json"
        private const val POINTER_SCHEMA = 1
        private const val MAX_ARTIFACT_BYTES = 1_048_576L
        private const val MAX_POINTER_BYTES = 256 * 1024
        private const val MAX_ETAG_LENGTH = 256
        private const val BUFFER_BYTES = 16 * 1024
        private val SHA256_PATTERN = Regex("[0-9a-f]{64}")

        private fun validEtag(etag: String): Boolean =
            etag.isNotBlank() && etag.length <= MAX_ETAG_LENGTH && etag.all { it in '!'..'~' }

        /**
         * Hashadressierte Medienreferenzen aus den geprueften Bytes, eindeutig je
         * SHA-256 in Manifestreihenfolge. Widerspruechliche Eintraege ergeben null.
         */
        private fun mediaOf(manifest: ManifestVerification.Verified): List<VerifiedMedia>? {
          return try {
            val envelope = JSONObject(String(manifest.bytes(), Charsets.UTF_8))
            val payload = JSONObject(String(Base64.getDecoder().decode(envelope.getString("payloadBase64")), Charsets.UTF_8))
            val entries = payload.getJSONArray("entries")
            val byHash = LinkedHashMap<String, VerifiedMedia>()
            val byId = HashMap<String, String>()
            for (index in 0 until entries.length()) {
                val entry = entries.getJSONObject(index)
                val mediaId = entry.getString("mediaId")
                val sha = entry.getString("sha256")
                val size = when (val raw = entry.opt("sizeBytes")) { is Int -> raw.toLong(); is Long -> raw; else -> null }
                    ?: return null
                val item = VerifiedMedia.of(mediaId, sha, size) ?: return null
                val knownHash = byId.putIfAbsent(mediaId, sha)
                if (knownHash != null && knownHash != sha) return null
                val known = byHash[sha]
                if (known == null) byHash[sha] = item else if (known.sizeBytes != size) return null
            }
            if (byHash.isEmpty()) null else byHash.values.toList()
          } catch (_: Exception) {
            null
          }
        }

        private fun sha256Hex(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

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
            return digest.digest().toHex()
        }

        private fun ByteArray.toHex(): String = joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
    }
}
