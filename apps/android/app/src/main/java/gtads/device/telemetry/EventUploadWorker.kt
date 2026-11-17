package gtads.device.telemetry

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import gtads.device.auth.DeviceAuthClient
import gtads.device.identity.DeviceIdentity
import gtads.device.registration.RegistrationRepository
import java.util.concurrent.TimeUnit

/** Eindeutiger Uploadauftrag mit Netzwerkbedingung (CX-094); keine zweite Scheduler-Bibliothek. */
object EventUploadScheduler {
    const val UNIQUE_UPLOAD = "gt-ads-events-upload"
    const val BACKOFF_SECONDS = 30L

    /** Vorhandene Arbeit bleibt erhalten (KEEP). */
    fun enqueue(context: Context, policy: ExistingWorkPolicy = ExistingWorkPolicy.KEEP) {
        val app = context.applicationContext
        val request = OneTimeWorkRequestBuilder<EventUploadWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
            .build()
        try {
            WorkManager.getInstance(app).enqueueUniqueWork(UNIQUE_UPLOAD, policy, request)
        } catch (_: IllegalStateException) {
            // WorkManager nicht verfuegbar; kein Ersatz-Scheduler.
        }
    }

    /** Erneute gueltige Registrierung bzw. expliziter neuer Anstoss: Sperre loesen und planen. */
    fun onRegistrationConfirmed(context: Context) {
        SharedPreferencesUploadGate(context).resume()
        enqueue(context)
    }
}

/**
 * Fuehrt pro Ausfuehrung genau einen Batch aus. Folgearbeit nur bei verbleibenden
 * Daten; voruebergehende Fehler nutzen den WorkManager-Backoff (30 s Start),
 * Sperrgruende beenden die automatische Wiederholung. Kein Schlafen im Worker.
 */
class EventUploadWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result {
        val coordinator = try {
            factory?.invoke(applicationContext) ?: production(applicationContext)
        } catch (_: Exception) {
            null
        } ?: return Result.success()
        return when (val outcome = coordinator.runOnce()) {
            UploadOutcome.Empty, is UploadOutcome.Stopped -> Result.success()
            is UploadOutcome.Uploaded -> {
                if (outcome.remaining) EventUploadScheduler.enqueue(applicationContext, ExistingWorkPolicy.APPEND_OR_REPLACE)
                Result.success()
            }
            UploadOutcome.Retry, UploadOutcome.Deferred -> Result.retry()
        }
    }

    companion object {
        @Volatile
        internal var factory: ((Context) -> EventUploadCoordinator?)? = null

        private fun production(context: Context): EventUploadCoordinator? {
            val binding = RegistrationRepository(context).readBinding() ?: return null
            val auth = DeviceAuthClient(
                baseUrl = binding.baseUrl,
                deviceId = binding.deviceId,
                sign = { bytes -> DeviceIdentity().sign(bytes) },
            )
            val transport = DeviceEventTransport(binding.baseUrl, auth)
            return EventUploadCoordinator(
                database = TelemetryEventDatabase(context).writableDatabase,
                deviceId = binding.deviceId,
                send = transport::send,
                gate = SharedPreferencesUploadGate(context),
            )
        }
    }
}
