package gtads.device.heartbeat

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import gtads.device.auth.DeviceAuthClient
import gtads.device.identity.DeviceIdentity
import gtads.device.registration.RegistrationRepository
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * Produktive Verdrahtung des StatusReporters (CX-085).
 *
 * Ohne persistierte Geraetebindung entsteht kein Reporter; es werden weder
 * Adresse noch Identitaet erfunden. Der Reporter lebt ausschliesslich im
 * Activity-Lifecycle und laeuft nicht im Hintergrund weiter.
 */
object HeartbeatRuntime {
    @Volatile
    private var overrides: ((Context) -> StatusReporter?)? = null

    @Volatile
    private var executor: Executor = newExecutor()

    internal fun installForTest(factory: (Context) -> StatusReporter?) {
        overrides = factory
    }

    internal fun resetForTest() {
        overrides = null
    }

    fun create(context: Context): StatusReporter? {
        val app = context.applicationContext
        overrides?.let { return it(app) }
        return try {
            createProduction(app)
        } catch (_: Exception) {
            null
        }
    }

    private fun createProduction(context: Context): StatusReporter? {
        val binding = RegistrationRepository(context).readBinding() ?: return null
        val auth = DeviceAuthClient(
            baseUrl = binding.baseUrl,
            deviceId = binding.deviceId,
            sign = { bytes -> DeviceIdentity().sign(bytes) },
        )
        val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
        val versionName = packageInfo.versionName?.takeIf { it.isNotBlank() } ?: "0"
        return StatusReporter(
            transport = DeviceHeartbeatTransport(binding.baseUrl, auth),
            scheduler = HandlerReporterScheduler(),
            executor = executor,
            appVersion = { versionName },
            osVersion = { Build.VERSION.RELEASE?.takeIf { it.isNotBlank() } ?: "unknown" },
            sequence = SharedPreferencesSequenceStore(context),
        )
    }

    private fun newExecutor(): Executor =
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "device-heartbeat").apply { isDaemon = true }
        }
}

/** Handler-Zeitgeber auf dem Hauptlooper; nur fuer den aktiven Lifecycle. */
class HandlerReporterScheduler(
    private val looper: Looper = Looper.getMainLooper(),
) : ReporterScheduler {
    override fun schedule(delayMillis: Long, action: () -> Unit): ReporterScheduler.Cancellable {
        val handler = Handler(looper)
        val runnable = Runnable { action() }
        handler.postDelayed(runnable, delayMillis)
        return ReporterScheduler.Cancellable { handler.removeCallbacks(runnable) }
    }
}
