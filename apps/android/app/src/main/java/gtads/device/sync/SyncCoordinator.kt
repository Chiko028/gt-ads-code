package gtads.device.sync

import gtads.device.download.MediaDownloadResult
import gtads.device.download.MediaDownloader
import gtads.device.manifest.ManifestActivation
import gtads.device.manifest.ManifestFetchResult
import gtads.device.manifest.ManifestLoad
import gtads.device.manifest.ManifestRepository
import gtads.device.manifest.ManifestStoreFailure
import gtads.device.manifest.VerifiedManifestState
import gtads.device.manifest.VerifiedMedia
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CancellationException
import java.util.concurrent.locks.ReentrantLock

/**
 * Kleiner Koordinator fuer R-902. Er verdrahtet ausschliesslich die vorhandenen
 * Bausteine CX-074 (Manifestabruf), CX-075 (Mediendownload) und CX-076
 * (atomare Aktivierung). Es gibt keine eigene Registrierung, Identitaet,
 * Manifestpruefung oder Downloadlogik.
 *
 * Alle tatsaechlichen Laeufe sind im Prozess ueber eine nicht blockierende
 * Sperre serialisiert. Fehler lassen den bisherigen aktiven Stand unveraendert.
 */
class SyncCoordinator(
    private val repository: ManifestRepository,
    private val mediaDirectory: File,
    private val fetchManifest: (VerifiedManifestState?) -> ManifestFetchResult,
    private val grantUrl: (VerifiedMedia) -> String?,
    private val downloadMedia: (String, VerifiedMedia) -> MediaDownloadResult,
    private val freeSpaceBytes: () -> Long,
    private val authState: SyncAuthState,
    private val nowMs: () -> Long,
    private val deadlineMs: Long,
    private val isCancelled: () -> Boolean = { false },
) {
    fun run(): SyncRunResult {
        if (!RUN_LOCK.tryLock()) return SyncRunResult.Busy
        try {
            if (authState.isSuspended()) return SyncRunResult.AuthenticationBlocked
            val loaded = repository.load()
            if (loaded is ManifestLoad.Failed) return SyncRunResult.Failed(SyncFailure.INTEGRITY)
            val previous = (loaded as? ManifestLoad.Active)?.active
            val previousState = repository.verifiedState()

            if (cancelled()) throw CancellationException("sync cancelled")
            if (deadlineReached()) return SyncRunResult.Incomplete

            var candidate = when (val first = fetchManifest(previousState)) {
                is ManifestFetchResult.Candidate -> first.state
                ManifestFetchResult.Unchanged ->
                    return if (previous == null) {
                        SyncRunResult.Failed(SyncFailure.INVALID_INPUT)
                    } else {
                        SyncRunResult.Unchanged
                    }
                ManifestFetchResult.AuthenticationRequired -> return suspend()
                ManifestFetchResult.Timeout, ManifestFetchResult.Unavailable -> return SyncRunResult.Transient
                ManifestFetchResult.TooLarge -> return SyncRunResult.Failed(SyncFailure.INTEGRITY)
                is ManifestFetchResult.Invalid -> return SyncRunResult.Failed(SyncFailure.INTEGRITY)
                is ManifestFetchResult.Unexpected -> return SyncRunResult.Failed(SyncFailure.INVALID_INPUT)
                ManifestFetchResult.InvalidInput -> return SyncRunResult.Failed(SyncFailure.INVALID_INPUT)
            }

            var refetchUsed = false
            while (true) {
                val parsed = ManifestRepository.parseManifest(candidate.manifest)
                    ?: return SyncRunResult.Failed(SyncFailure.INTEGRITY)
                var grantExpired = false
                for (media in parsed.media) {
                    if (cancelled()) throw CancellationException("sync cancelled")
                    if (deadlineReached()) return SyncRunResult.Incomplete
                    val target = MediaDownloader.targetFile(mediaDirectory, media)
                    if (isComplete(target, media)) continue

                    val part = MediaDownloader.partFile(mediaDirectory, media)
                    val reusable = if (part.isFile && part.length() in 0L..media.sizeBytes) part.length() else 0L
                    val stillNeeded = media.sizeBytes - reusable
                    if (stillNeeded > 0L && freeSpaceBytes() < stillNeeded + STORAGE_RESERVE_BYTES) {
                        return SyncRunResult.Failed(SyncFailure.STORAGE_FULL)
                    }
                    val url = grantUrl(media) ?: return SyncRunResult.Failed(SyncFailure.GRANT_UNAVAILABLE)
                    when (val result = downloadMedia(url, media)) {
                        is MediaDownloadResult.Completed -> Unit
                        MediaDownloadResult.GrantExpired -> {
                            grantExpired = true
                            break
                        }
                        MediaDownloadResult.Retryable, MediaDownloadResult.RestartRequired ->
                            return SyncRunResult.Transient
                        is MediaDownloadResult.IntegrityFailure ->
                            return SyncRunResult.Failed(SyncFailure.INTEGRITY)
                        is MediaDownloadResult.Unexpected -> return SyncRunResult.Transient
                        MediaDownloadResult.InvalidInput ->
                            return SyncRunResult.Failed(SyncFailure.INVALID_INPUT)
                    }
                }
                if (!grantExpired) break

                if (refetchUsed) return SyncRunResult.Failed(SyncFailure.GRANT_EXPIRED)
                refetchUsed = true
                if (cancelled()) throw CancellationException("sync cancelled")
                if (deadlineReached()) return SyncRunResult.Incomplete
                candidate = when (val refetch = fetchManifest(candidate)) {
                    is ManifestFetchResult.Candidate -> refetch.state
                    ManifestFetchResult.Unchanged -> return SyncRunResult.Failed(SyncFailure.GRANT_EXPIRED)
                    ManifestFetchResult.AuthenticationRequired -> return suspend()
                    ManifestFetchResult.Timeout, ManifestFetchResult.Unavailable -> return SyncRunResult.Transient
                    ManifestFetchResult.TooLarge -> return SyncRunResult.Failed(SyncFailure.INTEGRITY)
                    is ManifestFetchResult.Invalid -> return SyncRunResult.Failed(SyncFailure.INTEGRITY)
                    is ManifestFetchResult.Unexpected -> return SyncRunResult.Failed(SyncFailure.INVALID_INPUT)
                    ManifestFetchResult.InvalidInput -> return SyncRunResult.Failed(SyncFailure.INVALID_INPUT)
                }
                // Ein geaenderter Kandidat wird ab dem ersten Medium vollstaendig neu bewertet.
            }

            if (cancelled()) throw CancellationException("sync cancelled")
            return when (val activation = repository.activate(candidate.manifest, candidate.etag)) {
                is ManifestActivation.Activated -> SyncRunResult.Activated
                ManifestActivation.Unchanged -> SyncRunResult.Unchanged
                is ManifestActivation.Rejected -> SyncRunResult.Failed(map(activation.code))
            }
        } finally {
            RUN_LOCK.unlock()
        }
    }

    private fun suspend(): SyncRunResult {
        authState.suspend()
        return SyncRunResult.AuthenticationBlocked
    }

    private fun cancelled(): Boolean = isCancelled()

    private fun deadlineReached(): Boolean = nowMs() >= deadlineMs

    private fun isComplete(file: File, media: VerifiedMedia): Boolean {
        if (!file.isFile || file.length() != media.sizeBytes) return false
        return try {
            sha256(file) == media.sha256
        } catch (_: Exception) {
            false
        }
    }

    private fun sha256(file: File): String {
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

    private fun map(code: ManifestStoreFailure): SyncFailure = when (code) {
        ManifestStoreFailure.STORAGE -> SyncFailure.STORAGE
        ManifestStoreFailure.INVALID_INPUT -> SyncFailure.INVALID_INPUT
        else -> SyncFailure.INTEGRITY
    }

    companion object {
        /** Mindestreserve, die beim Speichercheck immer frei bleiben muss (32 MiB). */
        const val STORAGE_RESERVE_BYTES = 32L * 1024L * 1024L

        /** Harte Obergrenze eines Laufs (acht Minuten). */
        const val MAX_RUN_MS = 8L * 60L * 1000L

        private const val BUFFER_BYTES = 16 * 1024
        private val RUN_LOCK = ReentrantLock()
    }
}

