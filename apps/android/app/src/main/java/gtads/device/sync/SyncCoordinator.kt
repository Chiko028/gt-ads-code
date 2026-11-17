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
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.concurrent.CancellationException
import java.util.concurrent.locks.ReentrantLock

/**
 * Kleiner Koordinator fuer R-902. Er verdrahtet ausschliesslich die vorhandenen
 * Bausteine CX-074 (Manifestabruf), CX-075 (Mediendownload) und CX-076
 * (atomare Aktivierung). Es gibt keine eigene Registrierung, Identitaet,
 * Manifestpruefung oder Downloadlogik.
 *
 * Jeder Lauf erhaelt beim Start eine lokal persistente, monoton steigende
 * Generation. Die vorhandene atomare Aktivierung prueft diese Generation
 * unmittelbar vor dem Zeigerwechsel; ein ueberholter Lauf kann den aktiven
 * Stand daher nicht mehr ersetzen. Temporaere Dateien liegen ausschliesslich
 * im laufeigenen Verzeichnis und werden nur dort bereinigt.
 */
class SyncCoordinator(
    private val repository: ManifestRepository,
    private val mediaDirectory: File,
    private val fetchManifest: (VerifiedManifestState?) -> ManifestFetchResult,
    private val grantUrl: (VerifiedMedia) -> String?,
    private val downloadMedia: (File, String, VerifiedMedia) -> MediaDownloadResult,
    private val freeSpaceBytes: () -> Long,
    private val authState: SyncAuthState,
    private val nowMs: () -> Long,
    private val deadlineMs: Long,
    private val isCancelled: () -> Boolean = { false },
) {
    fun run(): SyncRunResult {
        if (!RUN_LOCK.tryLock()) return SyncRunResult.Busy
        var ownedDirectory: File? = null
        try {
            if (authState.isSuspended()) return SyncRunResult.AuthenticationBlocked

            // Die Generation wird vor jedem Abruf und Download persistiert. Ein
            // spaeter startender Lauf erhoeht sie und entwertet damit jeden
            // noch laufenden aelteren Lauf.
            val generation = repository.beginRun() ?: return SyncRunResult.Failed(SyncFailure.STORAGE)

            val loaded = repository.load()
            if (loaded is ManifestLoad.Failed) return SyncRunResult.Failed(SyncFailure.INTEGRITY)
            val previous = (loaded as? ManifestLoad.Active)?.active
            val previousState = repository.verifiedState()
            val runDirectory = prepareRunDirectory(generation)
                ?: return SyncRunResult.Failed(SyncFailure.STORAGE)
            ownedDirectory = runDirectory

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
                    // Bereits hashgepruefte Medien werden unveraendert wiederverwendet.
                    if (isComplete(target, media)) continue

                    val part = MediaDownloader.partFile(runDirectory, media)
                    val reusable = if (part.isFile && part.length() in 0L..media.sizeBytes) part.length() else 0L
                    val stillNeeded = media.sizeBytes - reusable
                    if (stillNeeded > 0L && freeSpaceBytes() < stillNeeded + STORAGE_RESERVE_BYTES) {
                        return SyncRunResult.Failed(SyncFailure.STORAGE_FULL)
                    }
                    val url = grantUrl(media) ?: return SyncRunResult.Failed(SyncFailure.GRANT_UNAVAILABLE)
                    when (val result = downloadMedia(runDirectory, url, media)) {
                        is MediaDownloadResult.Completed -> if (!adopt(result.file, media)) {
                            return SyncRunResult.Failed(SyncFailure.INTEGRITY)
                        }
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
            return when (val activation = repository.activate(candidate.manifest, candidate.etag, generation)) {
                is ManifestActivation.Activated -> SyncRunResult.Activated
                ManifestActivation.Unchanged -> SyncRunResult.Unchanged
                is ManifestActivation.Rejected ->
                    if (activation.code == ManifestStoreFailure.SUPERSEDED) {
                        SyncRunResult.Superseded
                    } else {
                        SyncRunResult.Failed(map(activation.code))
                    }
            }
        } finally {
            try {
                ownedDirectory?.let { cleanupRunDirectory(it) }
            } finally {
                RUN_LOCK.unlock()
            }
        }
    }

    private fun suspend(): SyncRunResult {
        authState.suspend()
        return SyncRunResult.AuthenticationBlocked
    }

    private fun cancelled(): Boolean = isCancelled()

    private fun deadlineReached(): Boolean = nowMs() >= deadlineMs

    /** Legt das ausschliesslich diesem Lauf gehoerende temporaere Verzeichnis an. */
    private fun prepareRunDirectory(generation: Long): File? {
        val directory = runDirectoryFor(mediaDirectory, generation)
        if (directory.exists()) directory.deleteRecursively()
        if (!mediaDirectory.isDirectory && !mediaDirectory.mkdirs()) return null
        return if (directory.mkdirs()) directory else null
    }

    /**
     * Uebernimmt eine vollstaendig gepruefte Datei in den hashadressierten
     * Medienbestand. Bereits vorhandene, hashgepruefte Zieldateien bleiben
     * unangetastet; die eigene Kopie wird dann nur verworfen.
     */
    private fun adopt(file: File, media: VerifiedMedia): Boolean {
        val target = MediaDownloader.targetFile(mediaDirectory, media)
        if (isComplete(target, media)) {
            file.delete()
            return true
        }
        if (!file.isFile || file.length() != media.sizeBytes) return false
        val hash = try {
            sha256(file)
        } catch (_: Exception) {
            return false
        }
        if (hash != media.sha256) return false
        return try {
            Files.move(
                file.toPath(),
                target.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
            true
        } catch (_: AtomicMoveNotSupportedException) {
            try {
                Files.move(file.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
                true
            } catch (_: Exception) {
                false
            }
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Bereinigt ausschliesslich das laufeigene Verzeichnis. Ein bereits
     * uebernommenes Medium liegt ausserhalb und bleibt ebenso erhalten wie die
     * temporaeren Dateien anderer, noch laufender Generationen.
     */
    private fun cleanupRunDirectory(directory: File) {
        val children = directory.listFiles() ?: return
        for (child in children) {
            if (child.isDirectory) continue
            try {
                child.delete()
            } catch (_: Exception) {
                // Best-effort: der naechste Lauf verwendet ein neues Verzeichnis.
            }
        }
        try {
            directory.delete()
        } catch (_: Exception) {
            // Best-effort.
        }
    }

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
        private const val RUN_DIRECTORY_PREFIX = "sync-run-"
        private val RUN_LOCK = ReentrantLock()

        /** Temporaeres Verzeichnis genau einer Generation, nie gemeinsam genutzt. */
        internal fun runDirectoryFor(mediaDirectory: File, generation: Long): File =
            File(mediaDirectory, "$RUN_DIRECTORY_PREFIX$generation")
    }
}
