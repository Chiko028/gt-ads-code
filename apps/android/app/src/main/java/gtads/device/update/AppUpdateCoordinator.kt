package gtads.device.update

import java.io.File

/**
 * App-Updates aus der Ferne. Der Betreiber hat nach der Einrichtung keinen
 * Zugang mehr zu den Tablets; neue App-Versionen kommen deshalb ueber den
 * Server. Ablauf eines Laufs (selten: nach Start/Neustart und alle paar Stunden):
 *
 *  1. Eine zuvor gestartete Installation, die jetzt laeuft, als "installed" melden.
 *  2. Ziel vom Server holen (GET /v1/device/app-update). Kein Ziel oder nicht
 *     neuer als die installierte Version: nichts zu tun, alte Dateien weg.
 *  3. Nach zu vielen Fehlversuchen fuer dieselbe Version: aufgeben (kein
 *     Dauerkreislauf aus Laden und Scheitern), bis eine neue Version kommt.
 *  4. Fortsetzbar laden, Groesse und SHA-256 pruefen (MediaDownloader).
 *  5. Archiv pruefen: gleiches Paket, angekuendigter Versionscode, gleicher
 *     Signaturschluessel wie die installierte App. Android prueft die Signatur
 *     ohnehin; die Vorpruefung spart einen Installationsversuch.
 *  6. Ruhigen Moment abwarten (Stromanschluss getrennt = keine Wiedergabe),
 *     hoechstens [MAX_DEFER_MS] lang; danach trotzdem installieren.
 *  7. Installation starten (als Device Owner still). Das Ergebnis kommt
 *     asynchron ueber [onInstallResult].
 */
class AppUpdateCoordinator(
    private val ports: AppUpdatePorts,
    private val store: AppUpdateStore,
) {
    fun run(): AppUpdateRunResult {
        reportCompletedInstall()

        val offer = when (val fetched = ports.fetchOffer()) {
            is OfferResult.Offer -> fetched.offer
            OfferResult.None -> {
                ports.discardDownloads(keep = null)
                return AppUpdateRunResult.NoUpdate
            }
            OfferResult.Unavailable -> return AppUpdateRunResult.Unavailable
        }
        if (offer.versionCode <= ports.installedVersionCode()) {
            ports.discardDownloads(keep = null)
            return AppUpdateRunResult.UpToDate
        }
        if (store.failures(offer.releaseId) >= MAX_FAILURES) return AppUpdateRunResult.GaveUp

        val file = when (val downloaded = ports.download(offer)) {
            is DownloadOutcome.Completed -> downloaded.file
            DownloadOutcome.Retry -> return AppUpdateRunResult.Unavailable
            is DownloadOutcome.Failed -> {
                fail(offer, downloaded.detail)
                return AppUpdateRunResult.Failed
            }
        }
        ports.discardDownloads(keep = file)
        if (store.downloadedAtMs(offer.releaseId) == null) {
            store.markDownloaded(offer.releaseId, ports.nowMs())
            ports.report(offer.releaseId, STATUS_DOWNLOADED, null)
        }

        val archive = ports.inspectArchive(file)
        val problem = when {
            archive == null -> "archive_unreadable"
            archive.packageName != ports.ownPackageName() -> "package_mismatch"
            archive.versionCode != offer.versionCode -> "version_mismatch"
            !archive.sameSigner -> "signer_mismatch"
            else -> null
        }
        if (problem != null) {
            file.delete()
            fail(offer, problem)
            return AppUpdateRunResult.Failed
        }

        val downloadedAt = store.downloadedAtMs(offer.releaseId) ?: ports.nowMs()
        if (!ports.isQuietMoment() && ports.nowMs() - downloadedAt < MAX_DEFER_MS) {
            return AppUpdateRunResult.Deferred
        }

        store.markInstallStarted(offer.releaseId, offer.versionCode)
        return if (ports.install(file, offer)) {
            AppUpdateRunResult.InstallStarted
        } else {
            store.clearInstallStarted()
            fail(offer, "install_start")
            AppUpdateRunResult.Failed
        }
    }

    /**
     * Ergebnis der Plattform-Installation. Bei Erfolg beendet Android den
     * Prozess meist sofort; die Meldung "installed" folgt dann im naechsten
     * Lauf der neuen Version (Schritt 1).
     */
    fun onInstallResult(releaseId: String, success: Boolean, detail: String?) {
        if (success) {
            reportCompletedInstall()
            return
        }
        store.clearInstallStarted()
        store.addFailure(releaseId)
        ports.report(releaseId, STATUS_FAILED, detail ?: "install_failed")
    }

    private fun reportCompletedInstall() {
        val started = store.installStarted() ?: return
        if (ports.installedVersionCode() >= started.versionCode) {
            ports.report(started.releaseId, STATUS_INSTALLED, null)
            store.clearInstallStarted()
            ports.discardDownloads(keep = null)
        }
    }

    private fun fail(offer: AppUpdateOffer, detail: String) {
        store.addFailure(offer.releaseId)
        ports.report(offer.releaseId, STATUS_FAILED, detail)
    }

    companion object {
        const val MAX_FAILURES = 3
        /** Laengstens so lange auf einen ruhigen Moment warten (12 h). */
        const val MAX_DEFER_MS = 12L * 60L * 60L * 1000L
        const val STATUS_DOWNLOADED = "downloaded"
        const val STATUS_INSTALLED = "installed"
        const val STATUS_FAILED = "failed"
    }
}

/** Vom Server angekuendigte Version mit absoluter Download-URL (Ticket). */
data class AppUpdateOffer(
    val releaseId: String,
    val versionCode: Long,
    val versionName: String,
    val sha256: String,
    val sizeBytes: Long,
    val downloadUrl: String,
)

sealed interface OfferResult {
    data class Offer(val offer: AppUpdateOffer) : OfferResult
    data object None : OfferResult
    data object Unavailable : OfferResult
}

sealed interface DownloadOutcome {
    class Completed(val file: File) : DownloadOutcome
    /** Voruebergehend (Netz, Ticket abgelaufen): naechster Lauf versucht es erneut. */
    data object Retry : DownloadOutcome
    /** Integritaetsfehler oder ungueltige Angaben: zaehlt als Fehlversuch. */
    data class Failed(val detail: String) : DownloadOutcome
}

/** Angaben aus der heruntergeladenen APK. */
data class ArchiveInfo(val packageName: String, val versionCode: Long, val sameSigner: Boolean)

enum class AppUpdateRunResult { NoUpdate, UpToDate, Unavailable, Failed, GaveUp, Deferred, InstallStarted }

/** Plattform- und Netzgrenze; in Tests vollstaendig ersetzbar. */
interface AppUpdatePorts {
    fun fetchOffer(): OfferResult
    fun installedVersionCode(): Long
    fun ownPackageName(): String
    fun download(offer: AppUpdateOffer): DownloadOutcome
    /** Loescht alte Update-Dateien ausser [keep]. */
    fun discardDownloads(keep: File?)
    fun inspectArchive(file: File): ArchiveInfo?
    /** Kein Stromanschluss = keine Wiedergabe: guter Moment fuer den Neustart der App. */
    fun isQuietMoment(): Boolean
    /** Startet die Installation; false, wenn sie nicht gestartet werden konnte. */
    fun install(file: File, offer: AppUpdateOffer): Boolean
    /** Rueckmeldung an den Server (best effort, Fehler werden ignoriert). */
    fun report(releaseId: String, status: String, detail: String?)
    fun nowMs(): Long
}

/** Kleiner lokaler Zustand je Version (Fehlversuche, Ladezeitpunkt, laufende Installation). */
interface AppUpdateStore {
    fun failures(releaseId: String): Int
    fun addFailure(releaseId: String)
    fun downloadedAtMs(releaseId: String): Long?
    fun markDownloaded(releaseId: String, atMs: Long)
    fun installStarted(): StartedInstall?
    fun markInstallStarted(releaseId: String, versionCode: Long)
    fun clearInstallStarted()
}

data class StartedInstall(val releaseId: String, val versionCode: Long)
