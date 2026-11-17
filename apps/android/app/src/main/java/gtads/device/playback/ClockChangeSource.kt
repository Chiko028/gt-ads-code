package gtads.device.playback

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build

/**
 * CX-098: Quelle fuer Android-Zeit- und Zeitzonenaenderungen. Die Anmeldung ist
 * lebenszyklusgebunden; [subscribe] liefert die Abmeldung.
 */
fun interface ClockChangeSource {
    fun subscribe(onChange: () -> Unit): PlaybackTimer.Cancellable
}

/** Keine Zeitaenderungsbeobachtung (Tests ohne Android-Broadcasts). */
object NoClockChanges : ClockChangeSource {
    override fun subscribe(onChange: () -> Unit): PlaybackTimer.Cancellable =
        object : PlaybackTimer.Cancellable {
            override fun cancel() = Unit
        }
}

/**
 * Produktive Quelle: registriert fuer die Dauer der Wiedergabe einen Empfaenger
 * fuer ACTION_TIME_CHANGED und ACTION_TIMEZONE_CHANGED. Kein Manifesteintrag,
 * kein Dienst, kein Wake-Lock.
 */
class AndroidClockChangeSource(context: Context) : ClockChangeSource {
    private val appContext = context.applicationContext

    override fun subscribe(onChange: () -> Unit): PlaybackTimer.Cancellable {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                when (intent?.action) {
                    Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED -> onChange()
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_TIME_CHANGED)
            addAction(Intent.ACTION_TIMEZONE_CHANGED)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            appContext.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            appContext.registerReceiver(receiver, filter)
        }
        return object : PlaybackTimer.Cancellable {
            private var active = true

            override fun cancel() {
                if (!active) return
                active = false
                try {
                    appContext.unregisterReceiver(receiver)
                } catch (_: IllegalArgumentException) {
                    // Bereits abgemeldet.
                }
            }
        }
    }
}
