package gtads.device.sync

import gtads.device.download.MediaDownloadResult
import gtads.device.download.MediaDownloader
import gtads.device.manifest.ManifestFetchResult
import gtads.device.manifest.ManifestRepository
import gtads.device.manifest.ManifestVerification
import gtads.device.manifest.VerifiedManifestState
import gtads.device.manifest.VerifiedMedia
import gtads.device.manifest.verifyManifest
import java.io.File
import java.nio.file.Files
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject

internal const val SYNC_TAXI_ID = "SYN-taxi-077"
internal const val SYNC_KEY_ID = "cx077-test-key"
internal const val SYNC_BASE_URL = "https://sync.example.invalid/basis"
internal const val SYNC_ETAG = "\"SYN-etag-cx077\""

/** Echte temporaere Verzeichnisse und echte signierte Manifeste fuer CX-077. */
internal class SyncFixture {
    val root: File = Files.createTempDirectory("cx077").toFile()
    val store: File = File(root, "manifest-store")
    val mediaDirectory: File = File(root, "media-downloads").apply { mkdirs() }
    val manifestKeys: KeyPair = KeyPairGenerator.getInstance("EC").apply {
        initialize(ECGenParameterSpec("secp256r1"))
    }.generateKeyPair()

    fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

    fun manifest(vararg contents: ByteArray): ManifestVerification.Verified {
        val entries = JSONArray()
        contents.forEachIndexed { index, content ->
            entries.put(
                JSONObject()
                    .put("mediaId", "SYN-media-$index")
                    .put("sha256", sha256(content))
                    .put("sizeBytes", content.size)
                    .put("durationMs", 5000)
                    .put("campaignId", "SYN-campaign")
                    .put("startAt", "2026-12-01T08:00:00.000Z")
                    .put("endAt", "2026-12-01T18:00:00.000Z"),
            )
        }
        val payload = JSONObject()
            .put("schemaVersion", 1)
            .put("environment", "dev")
            .put("taxiId", SYNC_TAXI_ID)
            .put("slotCount", contents.size)
            .put("entries", entries)
            .toString().toByteArray(Charsets.UTF_8)
        val payloadBase64 = Base64.getEncoder().encodeToString(payload)
        val version = sha256(payload)
        val signature = Signature.getInstance("SHA256withECDSA").run {
            initSign(manifestKeys.private)
            update("gt-ads-manifest-v1\n$SYNC_KEY_ID\n$version\n$payloadBase64".toByteArray(Charsets.UTF_8))
            sign()
        }
        val envelope = JSONObject()
            .put("schemaVersion", 1)
            .put("keyId", SYNC_KEY_ID)
            .put("version", version)
            .put("payloadBase64", payloadBase64)
            .put("signatureBase64", Base64.getEncoder().encodeToString(signature))
            .toString().toByteArray(Charsets.UTF_8)
        return verifyManifest(envelope, manifestKeys.public, SYNC_TAXI_ID) as ManifestVerification.Verified
    }

    fun state(vararg contents: ByteArray): VerifiedManifestState =
        VerifiedManifestState(manifest(*contents), SYNC_ETAG)

    fun mediaOf(state: VerifiedManifestState): List<VerifiedMedia> =
        ManifestRepository.parseManifest(state.manifest)!!.media

    fun writeMedia(media: VerifiedMedia, content: ByteArray) {
        MediaDownloader.targetFile(mediaDirectory, media).writeBytes(content)
    }

    fun repository(): ManifestRepository =
        ManifestRepository(store, mediaDirectory, manifestKeys.public, SYNC_TAXI_ID)

    fun cleanup() {
        root.deleteRecursively()
    }
}

/** Serialisierte Sperre ohne Android-Abhaengigkeit. */
internal class InMemorySyncAuthState(private var suspended: Boolean = false) : SyncAuthState {
    override fun isSuspended(): Boolean = suspended

    override fun suspend() {
        suspended = true
    }

    override fun resume() {
        suspended = false
    }
}

/**
 * Fake-Transport an der Grenze zu CX-074/CX-075: liefert geprufte Kandidaten
 * und schreibt heruntergeladene Bytes in echte temporaere Dateien.
 */
internal class FakeSyncTransport(
    private val mediaDirectory: File,
    private val contents: Map<String, ByteArray>,
) {
    var candidate: VerifiedManifestState? = null
    var fetchOverride: ((VerifiedManifestState?) -> ManifestFetchResult)? = null
    var downloadOverride: ((File, VerifiedMedia) -> MediaDownloadResult)? = null
    var fetchCalls = 0
    var downloadCalls = 0
    val downloadedHashes = mutableListOf<String>()

    fun fetch(current: VerifiedManifestState?): ManifestFetchResult {
        fetchCalls++
        fetchOverride?.let { return it(current) }
        val next = candidate ?: return ManifestFetchResult.Unavailable
        return if (current != null && current.etag == next.etag &&
            current.manifest.bytes().contentEquals(next.manifest.bytes())
        ) {
            ManifestFetchResult.Unchanged
        } else {
            ManifestFetchResult.Candidate(next)
        }
    }

    fun download(directory: File, url: String, media: VerifiedMedia): MediaDownloadResult {
        downloadCalls++
        downloadedHashes.add(media.sha256)
        downloadOverride?.let { return it(directory, media) }
        val content = contents[media.sha256] ?: return MediaDownloadResult.Retryable
        val target = MediaDownloader.targetFile(directory, media)
        target.writeBytes(content)
        return MediaDownloadResult.Completed(target, media.sha256, content.size.toLong())
    }
}

internal fun SyncFixture.dependencies(
    transport: FakeSyncTransport,
    freeSpace: Long = 10L * 1024L * 1024L * 1024L,
    auth: SyncAuthState = InMemorySyncAuthState(),
    repository: ManifestRepository = repository(),
): SyncDependencies = SyncDependencies(
    repository = repository,
    mediaDirectory = mediaDirectory,
    fetchManifest = transport::fetch,
    grantUrl = { media -> "$SYNC_BASE_URL/v1/device/downloads/${media.mediaId}?ticket=syn" },
    downloadMedia = transport::download,
    freeSpaceBytes = { freeSpace },
    authState = auth,
    nowMs = { 1L },
)

internal fun SyncDependencies.coordinator(
    deadlineMs: Long = Long.MAX_VALUE,
    cancelled: () -> Boolean = { false },
): SyncCoordinator = SyncCoordinator(
    repository = repository,
    mediaDirectory = mediaDirectory,
    fetchManifest = fetchManifest,
    grantUrl = grantUrl,
    downloadMedia = downloadMedia,
    freeSpaceBytes = freeSpaceBytes,
    authState = authState,
    nowMs = nowMs,
    deadlineMs = deadlineMs,
    isCancelled = cancelled,
)

