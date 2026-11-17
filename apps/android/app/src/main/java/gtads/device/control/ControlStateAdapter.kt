package gtads.device.control

import java.util.concurrent.CopyOnWriteArrayList

/**
 * Wirksamer Zustand fuer den CX-083-Adapter.
 *
 * autoEnded ist nur wahr, wenn die CX-013-Konfiguration die Beendigung
 * tatsaechlich erlaubt: pause_max_duration_s oder pause_end_on_vehicle_off.
 */
data class EffectiveControlState(
    val paused: Boolean,
    val pauseRevision: Long,
    val configRevision: Long,
    val config: ControlConfigValues?,
    val autoEnded: Boolean,
)

/**
 * Kleiner beobachtbarer Adapter zwischen lokalem Kern und CX-083.
 *
 * Der Adapter liest denselben Store wie der Dienst; es gibt keine zweite
 * Zustandsquelle. Beobachter werden nach jedem erfolgreichen Commit und
 * einmal beim Registrieren benachrichtigt.
 */
class ControlStateAdapter(
    private val store: DeviceControlStore,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val listeners = CopyOnWriteArrayList<(EffectiveControlState) -> Unit>()

    fun current(vehicleOff: Boolean = false): EffectiveControlState =
        currentAt(clock(), vehicleOff)

    fun currentAt(nowEpochMillis: Long, vehicleOff: Boolean = false): EffectiveControlState {
        val stored = store.readState()
        val pause = stored.pause
        var effectivePaused = pause.paused
        var autoEnded = false
        if (pause.paused && pause.revision > 0L) {
            val config = stored.config?.values
            if (config != null) {
                if (config.pauseEndOnVehicleOff == true && vehicleOff) {
                    effectivePaused = false
                    autoEnded = true
                } else {
                    val maxDuration = config.pauseMaxDurationS
                    if (maxDuration != null && nowEpochMillis >= pause.appliedAtEpochMillis) {
                        val elapsedMillis = nowEpochMillis - pause.appliedAtEpochMillis
                        if (elapsedMillis / 1000L >= maxDuration) {
                            effectivePaused = false
                            autoEnded = true
                        }
                    }
                }
            }
        }
        return EffectiveControlState(
            paused = effectivePaused,
            pauseRevision = pause.revision,
            configRevision = stored.config?.revision ?: 0L,
            config = stored.config?.values,
            autoEnded = autoEnded,
        )
    }

    fun observe(listener: (EffectiveControlState) -> Unit): AutoCloseable {
        listeners.add(listener)
        listener(current())
        return AutoCloseable { listeners.remove(listener) }
    }

    fun publish(vehicleOff: Boolean = false) {
        val snapshot = current(vehicleOff)
        for (listener in listeners) {
            listener(snapshot)
        }
    }
}
