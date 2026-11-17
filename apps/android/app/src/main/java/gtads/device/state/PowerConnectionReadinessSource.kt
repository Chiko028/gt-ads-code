package gtads.device.state

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager

/**
 * Android-Adapter der Bereitschaft (R-904 / CX-085).
 *
 * Verwendet ausschliesslich den Stromanschluss des Geraets als ausdruecklich
 * gekennzeichneten technischen Proxy:
 * - angeschlossen -> [VehicleReadiness.ON]
 * - nicht angeschlossen -> [VehicleReadiness.OFF]
 * - kein Signal -> [VehicleReadiness.UNKNOWN]
 *
 * Das ist ausdruecklich KEINE nachgewiesene Fahrzeugzuendung. Es gibt keine
 * Fahrzeugbus-, GPS- oder Presence-Integration. Der Initialwert wird aus dem
 * vorhandenen Android-Signal gelesen; fehlt es, bleibt der Stand unknown.
 *
 * @param readInitial liefert true/false/null; im Produktivbetrieb
 *   BatteryManager.isCharging, in Tests ein kontrolliertes Signal.
 */
class PowerConnectionReadinessSource(
    context: Context,
    private val readInitial: () -> Boolean? = { defaultCharging(context) },
) : ReadinessSource {
    private val appContext: Context = context.applicationContext
    private var readiness: VehicleReadiness = classify(readInitial())
    private var observer: ((VehicleReadiness) -> Unit)? = null
    private var registered = false

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                Intent.ACTION_POWER_CONNECTED -> update(VehicleReadiness.ON)
                Intent.ACTION_POWER_DISCONNECTED -> update(VehicleReadiness.OFF)
            }
        }
    }

    override fun current(): VehicleReadiness = readiness

    override fun start(observer: (VehicleReadiness) -> Unit) {
        this.observer = observer
        if (registered) return
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
        }
        try {
            appContext.registerReceiver(receiver, filter)
            registered = true
        } catch (_: Exception) {
            // Ohne Empfaenger bleibt der ausgelesene Initialwert gueltig.
        }
    }

    override fun stop() {
        observer = null
        if (!registered) return
        registered = false
        try {
            appContext.unregisterReceiver(receiver)
        } catch (_: Exception) {
            // Ein bereits abgemeldeter Empfaenger ist kein Fehler.
        }
    }

    private fun update(next: VehicleReadiness) {
        if (readiness == next) return
        readiness = next
        observer?.invoke(next)
    }

    private fun classify(charging: Boolean?): VehicleReadiness = when (charging) {
        true -> VehicleReadiness.ON
        false -> VehicleReadiness.OFF
        null -> VehicleReadiness.UNKNOWN
    }

    companion object {
        /** Nur der Stromanschluss als technischer Proxy; null heisst unknown. */
        internal fun defaultCharging(context: Context): Boolean? = try {
            context.getSystemService(BatteryManager::class.java)?.isCharging
        } catch (_: Exception) {
            null
        }
    }
}
