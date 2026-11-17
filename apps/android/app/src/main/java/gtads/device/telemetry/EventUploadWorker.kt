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
        val request = request()
        try {
            WorkManager.getInstance(app).enqueueUniqueWork(UNIQUE_UPLOAD, policy, request)
        } catch (_: IllegalStateException) {
            // WorkManager nicht verfuegbar; kein Ersatz-Scheduler.
        }
    }

    /** REV-198: genau dieser Auftrag wird eingeplant (Netzwerkbedingung, exponentieller Backoff ab 30 s). */
    internal fun request() = OneTimeWorkRequestBuilder<EventUploadWorker>()
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
        .build()

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
        val status = TechnicalStatusStore(applicationContext)
        // REV-198: fehlende Registrierung ist kein Fehler (nichts zu senden, kein Retry).
        val testFactory = factory
        if (testFactory == null && RegistrationRepository(applicationContext).readBinding() == null) return Result.success()
        val prepared = try {
            if (testFactory != null) testFactory(applicationContext)?.let { Prepared(it) {} } else production(applicationContext)
        } catch (_: Exception) {
            null
        }
        if (prepared == null) {
            // Voruebergehender Initialisierungsfehler (z. B. Datenbank nicht oeffnbar): Retry mit Backoff, Status melden.
            status.report(STATUS_COMPONENT, "initialisierung_fehlgeschlagen")
            return Result.retry()
        }
        try {
            return when (val outcome = prepared.coordinator.runOnce()) {
                UploadOutcome.Empty -> {
                    status.clear(STATUS_COMPONENT)
                    Result.success()
                }
                is UploadOutcome.Stopped -> {
                    // REV-198: Sperrgrund geheimnisfrei als technischer Status (feste Codes aus dem Koordinator).
                    status.report(STATUS_COMPONENT, "gesperrt_" + outcome.reason)
                    Result.success()
                }
                is UploadOutcome.Uploaded -> {
                    status.clear(STATUS_COMPONENT)
                    if (outcome.remaining) EventUploadScheduler.enqueue(applicationContext, ExistingWorkPolicy.APPEND_OR_REPLACE)
                    Result.success()
                }
                UploadOutcome.Retry, UploadOutcome.Deferred -> Result.retry()
            }
        } finally {
            prepared.close() // REV-198: Datenbank je Ausfuehrung deterministisch schliessen
        }
    }

    private class Prepared(val coordinator: EventUploadCoordinator, val close: () -> Unit)

    companion object {
        const val STATUS_COMPONENT = "ereignis_upload"

        @Volatile
        internal var factory: ((Context) -> EventUploadCoordinator?)? = null

        private fun production(context: Context): Prepared? {
            val binding = RegistrationRepository(context).readBinding() ?: return null
            val auth = DeviceAuthClient(
                baseUrl = binding.baseUrl,
                deviceId = binding.deviceId,
                sign = { bytes -> DeviceIdentity().sign(bytes) },
            )
            val transport = DeviceEventTransport(binding.baseUrl, auth)
            val helper = TelemetryEventDatabase(context)
            val database = try {
                helper.writableDatabase
            } catch (error: Exception) {
                helper.close()
                throw error
            }
            val coordinator = EventUploadCoordinator(
                database = database,
                deviceId = binding.deviceId,
                send = transport::send,
                gate = SharedPreferencesUploadGate(context),
            )
            return Prepared(coordinator) { helper.close() }
        }
    }
}

/**
 * REV-198: lokaler, geheimnisfreier technischer Status je Baustein (feste Codes, keine Nutzdaten,
 * keine Nachweise). Kein weiterer StatusReporter; der vorhandene Heartbeat-Vertrag bleibt unveraendert.
 */
class TechnicalStatusStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun report(component: String, code: String) {
        preferences.edit().putString(component, code.take(MAX_CODE)).apply()
    }

    fun clear(component: String) {
        preferences.edit().remove(component).apply()
    }

    fun current(component: String): String? = preferences.getString(component, null)

    private companion object {
        const val PREFS = "gtads-technischer-status"
        const val MAX_CODE = 64
    }
}
