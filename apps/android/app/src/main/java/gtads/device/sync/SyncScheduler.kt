package gtads.device.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import gtads.device.registration.RegistrationRepository
import java.util.concurrent.TimeUnit

/**
 * Eindeutige Arbeitsketten fuer R-902. Nach bestaetigter Registrierung wird
 * genau eine einmalige Arbeit eingereiht; bei bestehender Registrierung wird
 * eine eindeutige periodische Arbeit mit mindestens 15 Minuten und
 * Netzwerkbedingung sichergestellt. Keine weitere Scheduler-Bibliothek.
 */
object SyncScheduler {
    const val UNIQUE_ONE_TIME = "gt-ads-sync-once"
    const val UNIQUE_PERIODIC = "gt-ads-sync-periodic"
    private const val BACKOFF_SECONDS = 30L

    /** Expliziter erfolgreicher Registrierungsvorgang: Sperre loesen und Arbeit einreihen. */
    fun onRegistrationConfirmed(context: Context) {
        val app = context.applicationContext
        SyncAuthGate(app).resume()
        enqueueOneTime(app)
        ensurePeriodic(app)
    }

    fun enqueueOneTime(context: Context) {
        val app = context.applicationContext
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
            .build()
        try {
            WorkManager.getInstance(app)
                .enqueueUniqueWork(UNIQUE_ONE_TIME, ExistingWorkPolicy.KEEP, request)
        } catch (_: IllegalStateException) {
            // WorkManager ist in diesem Prozess nicht verfuegbar; kein zweiter Scheduler.
        }
    }

    fun ensurePeriodic(context: Context) {
        val app = context.applicationContext
        if (RegistrationRepository(app).readBinding() == null) return
        val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
            .build()
        try {
            WorkManager.getInstance(app)
                .enqueueUniquePeriodicWork(UNIQUE_PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
        } catch (_: IllegalStateException) {
            // WorkManager ist in diesem Prozess nicht verfuegbar; kein zweiter Scheduler.
        }
    }
}

