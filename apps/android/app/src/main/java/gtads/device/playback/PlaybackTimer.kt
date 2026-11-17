package gtads.device.playback

import android.os.Handler
import android.os.Looper

/**
 * Kleiner, abbrechbarer Timer der sichtbaren Wiedergabe (CX-082 / R-903).
 *
 * Der Produktivpfad bindet ihn an den Main-Looper; Tests setzen eine
 * kontrollierte Implementierung ein und loesen die geplante Aktion selbst aus.
 */
interface PlaybackTimer {
    fun schedule(delayMs: Long, action: () -> Unit): Cancellable

    interface Cancellable {
        fun cancel()
    }
}

/** Produktiver Timer auf dem Main-Thread; kein eigener Thread, keine Wachhaltung. */
class HandlerPlaybackTimer(looper: Looper = Looper.getMainLooper()) : PlaybackTimer {
    private val handler = Handler(looper)

    override fun schedule(delayMs: Long, action: () -> Unit): PlaybackTimer.Cancellable {
        val runnable = Runnable { action() }
        handler.postDelayed(runnable, delayMs.coerceAtLeast(0L))
        return object : PlaybackTimer.Cancellable {
            override fun cancel() {
                handler.removeCallbacks(runnable)
            }
        }
    }
}
