package gtads.device.sync

import android.content.Context
import android.os.SystemClock
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.CancellationException

/**
 * WorkManager-Worker fuer R-902. Er entscheidet nur ueber das Ergebnis des
 * Koordinators: voruebergehende Netzfehler und unvollstaendige Laeufe werden
 * per Retry mit exponentiellem Backoff fortgesetzt, feste Fehler beenden den
 * Lauf ohne Aktivierungswechsel.
 */
class SyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : Worker(appContext, params) {
    override fun doWork(): Result {
        // CX-149: Konfiguration (Taxi, Manifestschluessel) im Hintergrund aktualisieren und an
        // SyncRuntime/ControlRuntime binden; ein Fehler laesst die zuletzt gespeicherte gelten.
        gtads.device.config.DeviceRuntimeSetup.install()
        try {
            gtads.device.config.DeviceRuntimeSetup.refresh(applicationContext)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Weiter mit gespeicherter Konfiguration.
        }
        val dependencies = try {
            SyncRuntime.dependencies(applicationContext)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return Result.failure()
        } ?: return Result.success()

        val coordinator = SyncCoordinator(
            repository = dependencies.repository,
            mediaDirectory = dependencies.mediaDirectory,
            fetchManifest = dependencies.fetchManifest,
            grantUrl = dependencies.grantUrl,
            downloadMedia = dependencies.downloadMedia,
            freeSpaceBytes = dependencies.freeSpaceBytes,
            authState = dependencies.authState,
            nowMs = SystemClock::elapsedRealtime,
            deadlineMs = SystemClock.elapsedRealtime() + SyncCoordinator.MAX_RUN_MS,
            isCancelled = { isStopped },
        )
        // CX-087: derselbe eindeutige Hintergrundauftrag ruft auch ausstehende
        // Befehle ab und wiederholt Quittungen (best effort, ohne eigenes Intervall).
        try {
            gtads.device.control.ControlRuntime.poller(applicationContext)?.pollOnce()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Befehlsabruf beeinflusst das Synchronisierungsergebnis nicht.
        }
        // Info-Karten (Wetter, Schlagzeilen): hoechstens alle drei Stunden, best effort.
        try {
            gtads.device.info.InfoSync.runFor(applicationContext)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Info-Karten beeinflussen das Synchronisierungsergebnis nicht.
        }
        return try {
            when (coordinator.run()) {
                SyncRunResult.Activated,
                SyncRunResult.Unchanged,
                SyncRunResult.Superseded,
                SyncRunResult.Busy,
                SyncRunResult.AuthenticationBlocked -> Result.success()
                SyncRunResult.Transient,
                SyncRunResult.Incomplete -> Result.retry()
                SyncRunResult.Cancelled -> Result.failure()
                is SyncRunResult.Failed -> Result.failure()
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            Result.failure()
        }
    }
}

