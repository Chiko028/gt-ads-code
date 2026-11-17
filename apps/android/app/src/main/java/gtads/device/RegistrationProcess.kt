package gtads.device

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import gtads.device.identity.DeviceIdentity
import gtads.device.registration.DeviceRegistrationTransport
import gtads.device.registration.RegistrationCoordinator
import gtads.device.registration.RegistrationDeviceInfo
import gtads.device.registration.RegistrationOutcome
import gtads.device.registration.RegistrationRepository
import gtads.device.registration.RegistrationState
import gtads.device.sync.SyncScheduler
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * App-prozessgebundener Zustandsinhaber. Er haelt einen laufenden Vorgang
 * ueber Activity-Neuerstellung hinweg, fuehrt saemtliche E-A-I auf einem
 * einzelnen Hintergrund-Executor aus und meldet UI-Zustaende nur auf dem
 * Hauptthread. Ein Prozessneustart liest ausschliesslich die persistierte
 * Zuordnung und registriert nie automatisch.
 */
object RegistrationProcess {
    private const val APP_ENV = "dev"
    private const val APP_FLAVOR = "dev"

    private val mainHandler: Handler by lazy { Handler(Looper.getMainLooper()) }
    private val listeners = CopyOnWriteArraySet<(RegistrationScreenState) -> Unit>()
    private val lock = Any()

    private var running = false
    private var loaded = false
    private var last: RegistrationScreenState? = null

    @Volatile
    private var executor: Executor = newExecutor()

    @Volatile
    private var coordinatorFactory: ((Context, String) -> RegistrationCoordinator)? = null

    @Volatile
    private var registrationHook: (Context) -> Unit = { SyncScheduler.onRegistrationConfirmed(it) }

    /** Meldet den aktuellen Zustand sofort (auf dem Hauptthread) und spaeter jede Aenderung. */
    fun observe(listener: (RegistrationScreenState) -> Unit) {
        listeners.add(listener)
        val current = synchronized(lock) {
            if (running) RegistrationScreenState.InProgress else last
        }
        mainHandler.post { listener(current ?: RegistrationScreenState.Loading) }
    }

    fun remove(listener: (RegistrationScreenState) -> Unit) {
        listeners.remove(listener)
    }

    /** Liest hoechstens einmal je Prozess die persistierte Zuordnung; startet keinen Request. */
    fun load(context: Context) {
        val app = context.applicationContext
        synchronized(lock) {
            if (loaded || running) return
            loaded = true
        }
        executor.execute {
            val state = readStored(app)
            synchronized(lock) {
                if (!running) last = state
            }
            notifyOnMain(state)
        }
    }

    /** Startet genau einen Versuch, solange kein anderer laeuft. */
    fun start(context: Context, baseUrl: String, code: String): Boolean {
        val app = context.applicationContext
        val coordinator = try {
            synchronized(lock) {
                if (running) return false
                running = true
                loaded = true
                last = null
                coordinatorFactory?.invoke(app, baseUrl) ?: createCoordinator(app, baseUrl)
            }
        } catch (_: Exception) {
            synchronized(lock) { running = false }
            notifyOnMain(RegistrationScreenState.Message(R.string.registration_message_unknown))
            return false
        }
        notifyOnMain(RegistrationScreenState.InProgress)
        executor.execute {
            val state = try {
                coordinator.register(code)
            } catch (_: Exception) {
                RegistrationState.Unknown
            }
            val screen = mapState(state, coordinator.outcome())
            if (screen is RegistrationScreenState.Registered) {
                try {
                    registrationHook(app)
                } catch (_: Exception) {
                    // Die Anzeige des erfolgreichen Uebergangs darf nicht an der Planung scheitern.
                }
            }
            synchronized(lock) {
                running = false
                last = screen
            }
            notifyOnMain(screen)
        }
        return true
    }

    internal fun configureForTest(
        factory: (Context, String) -> RegistrationCoordinator,
        testExecutor: Executor,
    ) {
        synchronized(lock) {
            running = false
            loaded = false
            last = null
        }
        listeners.clear()
        coordinatorFactory = factory
        registrationHook = {}
        executor = testExecutor
    }

    internal fun resetForTest() {
        synchronized(lock) {
            running = false
            loaded = false
            last = null
        }
        listeners.clear()
        coordinatorFactory = null
        registrationHook = { SyncScheduler.onRegistrationConfirmed(it) }
        executor = newExecutor()
    }

    private fun readStored(context: Context): RegistrationScreenState =
        when (val state = RegistrationRepository(context).read()) {
            is RegistrationState.Registered ->
                RegistrationScreenState.Registered(state.deviceId, state.baseUrl)
            RegistrationState.NotRegistered -> RegistrationScreenState.NotRegistered
            else -> RegistrationScreenState.Message(R.string.registration_message_unknown)
        }

    private fun mapState(
        state: RegistrationState,
        outcome: RegistrationOutcome?,
    ): RegistrationScreenState = when {
        state is RegistrationState.Registered ->
            RegistrationScreenState.Registered(state.deviceId, state.baseUrl)
        state is RegistrationState.Registering -> RegistrationScreenState.InProgress
        outcome == RegistrationOutcome.INVALID_INPUT ->
            RegistrationScreenState.Message(R.string.registration_message_invalid_input)
        outcome == RegistrationOutcome.CODE_REJECTED ->
            RegistrationScreenState.Message(R.string.registration_message_code_rejected)
        outcome == RegistrationOutcome.RATE_LIMITED ->
            RegistrationScreenState.Message(R.string.registration_message_rate_limited)
        outcome == RegistrationOutcome.NETWORK_ERROR ->
            RegistrationScreenState.Message(R.string.registration_message_network_error)
        state is RegistrationState.NotRegistered -> RegistrationScreenState.NotRegistered
        else -> RegistrationScreenState.Message(R.string.registration_message_unknown)
    }

    private fun createCoordinator(context: Context, baseUrl: String): RegistrationCoordinator {
        val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
        return RegistrationCoordinator(
            repository = RegistrationRepository(context),
            identity = DeviceIdentity(),
            baseUrl = baseUrl,
            appEnv = APP_ENV,
            deviceInfo = RegistrationDeviceInfo(
                manufacturer = Build.MANUFACTURER,
                model = Build.MODEL,
                osVersion = Build.VERSION.RELEASE,
                sdkInt = Build.VERSION.SDK_INT,
                appVersion = packageInfo.versionName ?: "",
                appFlavor = APP_FLAVOR,
            ),
            transport = { bytes -> DeviceRegistrationTransport(baseUrl).send(bytes) },
        )
    }

    private fun notifyOnMain(state: RegistrationScreenState) {
        mainHandler.post { listeners.forEach { it(state) } }
    }

    private fun newExecutor(): Executor =
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "device-registration").apply { isDaemon = true }
        }
}
