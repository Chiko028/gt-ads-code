package gtads.device.control

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import gtads.device.auth.DeviceAuthClient
import gtads.device.identity.DeviceIdentity
import gtads.device.registration.RegistrationBinding
import gtads.device.registration.RegistrationRepository
import java.util.concurrent.Executors

/**
 * Produktive Verdrahtung von CX-087. Die Taxi-Bindung erfindet die App nicht;
 * sie wird wie bei CX-077 ueber [configure] von der vorgelagerten Zuordnung
 * geliefert. Fehlt sie, wird nicht abgerufen.
 */
object ControlRuntime {
    @Volatile
    private var taxiProvider: ((Context, RegistrationBinding) -> String?)? = null

    @Volatile
    private var testPoller: ((Context) -> CommandPoller?)? = null

    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "gtads-commands").apply { isDaemon = true }
    }

    fun configure(provider: (Context, RegistrationBinding) -> String?) {
        taxiProvider = provider
    }

    internal fun installForTest(factory: (Context) -> CommandPoller?) {
        testPoller = factory
    }

    internal fun resetForTest() {
        testPoller = null
        taxiProvider = null
    }

    fun poller(context: Context): CommandPoller? {
        testPoller?.let { return it(context) }
        val registration = RegistrationRepository(context).readBinding() ?: return null
        val taxiId = taxiProvider?.invoke(context, registration) ?: return null
        val binding = DeviceBinding(registration.deviceId, taxiId)
        val auth = DeviceAuthClient(
            baseUrl = registration.baseUrl,
            deviceId = registration.deviceId,
            sign = { bytes -> DeviceIdentity().sign(bytes) },
        )
        return CommandPoller(
            transport = HttpCommandTransport(registration.baseUrl, auth),
            service = DeviceControlService(DeviceControlStore(context), binding),
            binding = binding,
            revocation = SharedPreferencesRevocationLatch(context),
            monotonicMs = SystemClock::elapsedRealtime,
        )
    }

    /** Lebenszyklusgebundene Schleife fuer den sichtbaren Vordergrund (15 s). */
    fun loop(context: Context): CommandPollingLoop? {
        val poller = poller(context) ?: return null
        val handler = Handler(Looper.getMainLooper())
        return CommandPollingLoop(
            poller = poller,
            schedule = { delay, action ->
                val runnable = Runnable { action() }
                handler.postDelayed(runnable, delay)
                AutoCloseable { handler.removeCallbacks(runnable) }
            },
            execute = { work -> executor.execute(work) },
        )
    }
}
