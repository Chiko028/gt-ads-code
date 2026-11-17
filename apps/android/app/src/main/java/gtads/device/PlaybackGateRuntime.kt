package gtads.device

import android.content.Context
import android.os.Handler
import android.os.Looper
import gtads.device.playback.PlaybackRuntime
import gtads.device.registration.RegistrationRepository
import gtads.device.state.ContentAvailability
import gtads.device.state.DEFAULT_DISPLAY_GRACE_MILLIS
import gtads.device.state.GateDecision
import gtads.device.state.PlaybackStateCoordinator
import gtads.device.state.PlaybackStateMachine
import gtads.device.state.PowerConnectionReadinessSource
import gtads.device.state.ReadinessSource
import gtads.device.state.ScheduledTask
import gtads.device.state.StateChangeRecorder
import gtads.device.state.StateMachineConfig
import gtads.device.telemetry.TelemetryEventDatabase

/**
 * Produktive Anbindung des Zustandsautomaten an die bestehende Activity
 * (CX-085 / R-904).
 *
 * Die Bereitschaft stammt ausschliesslich aus dem Stromanschluss des
 * Geraets (technischer Proxy, keine Fahrzeugzuendung). Der Inhalt ergibt
 * sich aus dem vorhandenen aktivierten lokalen Stand; der Playerzustand
 * bleibt beim bestehenden Controller. Zustandswechsel werden ueber den
 * CX-084-Puffer geschrieben, sobald eine Geraetebindung existiert.
 */
object PlaybackGateRuntime {
    private class Overrides(
        val factory: (Context, (GateDecision) -> Unit) -> PlaybackStateCoordinator?,
    )

    @Volatile
    private var overrides: Overrides? = null

    internal fun installForTest(
        factory: (Context, (GateDecision) -> Unit) -> PlaybackStateCoordinator?,
    ) {
        overrides = Overrides(factory)
    }

    internal fun resetForTest() {
        overrides = null
    }

    fun create(
        context: Context,
        onDecision: (GateDecision) -> Unit,
        /** CX-089: technischer Playerzustand (Watchdog), Standard OK. */
        playerCondition: () -> gtads.device.state.PlayerCondition = { gtads.device.state.PlayerCondition.OK },
    ): PlaybackStateCoordinator? {
        val app = context.applicationContext
        overrides?.let { return it.factory(app, onDecision) }
        return try {
            createProduction(app, onDecision, playerCondition)
        } catch (_: Exception) {
            null
        }
    }

    private fun createProduction(
        context: Context,
        onDecision: (GateDecision) -> Unit,
        playerCondition: () -> gtads.device.state.PlayerCondition,
    ): PlaybackStateCoordinator {
        val readiness: ReadinessSource = PowerConnectionReadinessSource(context)
        val snapshots = PlaybackRuntime.snapshotProvider(context)
        // CX-100: Barriere bis der persistente Pausenzustand (CX-086) geladen ist.
        var coordinator: PlaybackStateCoordinator? = null
        val mainHandler = Handler(Looper.getMainLooper())
        val restore = gtads.device.state.PauseRestore(
            read = {
                gtads.device.control.DeviceControlStore(context.applicationContext).use { store ->
                    gtads.device.control.ControlStateAdapter(store).current().paused
                }
            },
            // Kleiner lokaler Lesezugriff direkt im Lifecycle-Start: kein Zwischenzustand
            // ohne geladenen Pausenstand; bei Lesefehler bleibt die Barriere geschlossen.
            execute = { work -> work() },
            onChange = { mainHandler.post { coordinator?.refresh() } },
        )
        return PlaybackStateCoordinator(
            machine = PlaybackStateMachine(StateMachineConfig()),
            readiness = readiness,
            content = {
                if (snapshots() != null) ContentAvailability.VALID else ContentAvailability.NONE
            },
            player = playerCondition,
            recorder = { createRecorder(context) },
            displayGraceMillis = DEFAULT_DISPLAY_GRACE_MILLIS,
            schedule = { delay, action -> HandlerScheduledTask(delay, action) },
            onDecision = onDecision,
            periodicMark = gtads.device.state.SharedPreferencesPeriodicStatusMark(context),
            pauseRestore = restore,
        ).also { coordinator = it }
    }

    private fun createRecorder(context: Context): StateChangeRecorder? {
        val binding = RegistrationRepository(context).readBinding() ?: return null
        val database = try {
            TelemetryEventDatabase(context).writableDatabase
        } catch (_: Exception) {
            return null
        }
        return StateChangeRecorder(database, binding.deviceId)
    }
}

private class HandlerScheduledTask(
    delayMillis: Long,
    action: () -> Unit,
) : ScheduledTask {
    private val handler = Handler(Looper.getMainLooper())
    private val runnable = Runnable { action() }

    init {
        handler.postDelayed(runnable, delayMillis)
    }

    override fun cancel() {
        handler.removeCallbacks(runnable)
    }
}
