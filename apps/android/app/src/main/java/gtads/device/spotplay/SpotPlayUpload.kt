package gtads.device.spotplay

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import gtads.device.auth.DeviceAuthClient
import gtads.device.identity.DeviceIdentity
import gtads.device.playback.SpotPlayRecord
import gtads.device.playback.SpotPlaySink
import gtads.device.registration.RegistrationRepository
import gtads.device.telemetry.BatchRoute
import gtads.device.telemetry.DeviceEventTransport
import gtads.device.telemetry.EventUploadCoordinator
import gtads.device.telemetry.SharedPreferencesUploadGate
import gtads.device.telemetry.TechnicalStatusStore
import gtads.device.telemetry.UploadOutcome
import java.util.concurrent.TimeUnit

/**
 * CX-160 / R-903: regelmaessiger Upload der Abspielnachweise.
 *
 * Es gibt genau einen einmaligen Anstoss (App-Start) und genau eine periodische
 * Arbeit mit 15 Minuten Abstand; beide verlangen eine Netzwerkverbindung und
 * verwenden den vorhandenen WorkManager (keine zweite Scheduler-Bibliothek).
 * Ein App-Start loest eine zuvor gesetzte Sperre (Auth-/Dauerfehler) und plant
 * sofort einen Lauf.
 */
object SpotPlayUploadScheduler {
    const val UNIQUE_ONE_TIME = "gt-ads-spot-plays-once"
    const val UNIQUE_PERIODIC = "gt-ads-spot-plays-periodic"
    const val INTERVAL_MINUTES = 15L
    const val BACKOFF_SECONDS = 30L
    internal const val PREFERENCES_NAME = "spot-play-upload"

    fun enqueueOneTime(context: Context, policy: ExistingWorkPolicy = ExistingWorkPolicy.KEEP) {
        val app = context.applicationContext
        try {
            WorkManager.getInstance(app).enqueueUniqueWork(UNIQUE_ONE_TIME, policy, oneTimeRequest())
        } catch (_: IllegalStateException) {
            // WorkManager nicht verfuegbar; kein Ersatz-Scheduler.
        }
    }

    /** Periodische Arbeit bleibt bei wiederholtem App-Start erhalten (KEEP). */
    fun ensurePeriodic(context: Context) {
        val app = context.applicationContext
        try {
            WorkManager.getInstance(app).enqueueUniquePeriodicWork(
                UNIQUE_PERIODIC,
                ExistingPeriodicWorkPolicy.KEEP,
                periodicRequest(),
            )
        } catch (_: IllegalStateException) {
            // WorkManager nicht verfuegbar; kein Ersatz-Scheduler.
        }
    }

    /** Bestehende Bindung: Sperre loesen und sofort einen begrenzten Lauf anstossen. */
    fun onAppStarted(context: Context) {
        SharedPreferencesUploadGate(context, PREFERENCES_NAME).resume()
        ensurePeriodic(context)
        enqueueOneTime(context)
    }

    internal fun oneTimeRequest() = OneTimeWorkRequestBuilder<SpotPlayUploadWorker>()
        .setConstraints(networkConstraints())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
        .build()

    internal fun periodicRequest() = PeriodicWorkRequestBuilder<SpotPlayUploadWorker>(
        INTERVAL_MINUTES,
        TimeUnit.MINUTES,
    )
        .setConstraints(networkConstraints())
        .build()

    private fun networkConstraints() = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()
}

/**
 * Ein Batch je Ausfuehrung aus dem lokalen Spot-Puffer (Tabelle spot_plays).
 * Bestaetigt werden ausschliesslich die vom Server genannten play_ids; nur diese
 * Zeilen werden geloescht. Voruebergehende Fehler nutzen den WorkManager-Backoff,
 * Auth-/Dauerfehler sperren bis zum naechsten App-Start.
 */
class SpotPlayUploadWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result {
        val status = TechnicalStatusStore(applicationContext)
        val testFactory = factory
        if (testFactory == null && RegistrationRepository(applicationContext).readBinding() == null) {
            return Result.success()
        }
        val prepared = try {
            if (testFactory != null) {
                testFactory(applicationContext)?.let { Prepared(it) {} }
            } else {
                production(applicationContext)
            }
        } catch (_: Exception) {
            null
        }
        if (prepared == null) {
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
                    status.report(STATUS_COMPONENT, "gesperrt_" + outcome.reason)
                    Result.success()
                }
                is UploadOutcome.Uploaded -> {
                    status.clear(STATUS_COMPONENT)
                    if (outcome.remaining) {
                        SpotPlayUploadScheduler.enqueueOneTime(applicationContext, ExistingWorkPolicy.APPEND_OR_REPLACE)
                    }
                    Result.success()
                }
                UploadOutcome.Retry, UploadOutcome.Deferred -> Result.retry()
            }
        } finally {
            prepared.close()
        }
    }

    private class Prepared(val coordinator: EventUploadCoordinator, val close: () -> Unit)

    companion object {
        const val STATUS_COMPONENT = "spot_play_upload"

        @Volatile
        internal var factory: ((Context) -> EventUploadCoordinator?)? = null

        private fun production(context: Context): Prepared? {
            val binding = RegistrationRepository(context).readBinding() ?: return null
            val auth = DeviceAuthClient(
                baseUrl = binding.baseUrl,
                deviceId = binding.deviceId,
                sign = { bytes -> DeviceIdentity().sign(bytes) },
            )
            val transport = DeviceEventTransport(binding.baseUrl, auth, BatchRoute.SPOT_PLAYS)
            val helper = SpotPlayDatabase(context)
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
                gate = SharedPreferencesUploadGate(context, SpotPlayUploadScheduler.PREFERENCES_NAME),
                table = EventUploadCoordinator.TABLE_SPOT_PLAYS,
            )
            return Prepared(coordinator) { helper.close() }
        }
    }
}

/**
 * CX-160: produktive Senke des Controllers.
 *
 * Ohne gueltige Registrierung gibt es keinen Server und keine Geraete-ID; dann
 * wird der Nachweis still verworfen. Der Puffer oeffnet seine Datenbank je
 * Meldung kurz und schliesst sie wieder, damit ein Fehler nie die Wiedergabe
 * oder den naechsten Spot beeinflusst.
 */
object SpotPlayRuntime {
    fun sink(context: Context): SpotPlaySink {
        val app = context.applicationContext
        return SpotPlaySink { record -> persist(app, record) }
    }

    private fun persist(context: Context, record: SpotPlayRecord) {
        try {
            val binding = RegistrationRepository(context).readBinding() ?: return
            val helper = SpotPlayDatabase(context)
            try {
                SpotPlayRecorder(helper.writableDatabase, binding.deviceId).record(record)
            } finally {
                helper.close()
            }
        } catch (_: Exception) {
            // Der Abspielnachweis ist best effort; die Wiedergabe laeuft weiter.
        }
    }
}
