package gtads.device.watchdog

import gtads.device.playback.PlaybackController
import gtads.device.state.StateSnapshot

/**
 * Lebenszyklusgebundene Laufzeitanbindung von CX-088 (CX-089 / R-906).
 *
 * Prueft im bestehenden Wiedergabelebenszyklus alle zehn Sekunden den
 * tatsaechlichen Player-Fortschritt. Fristen und Versuchsbudget kommen
 * ausschliesslich aus [PlaybackWatchdog]; Wiederherstellung ist das
 * kontrollierte Freigeben und Neuerstellen des vorhandenen Playeradapters
 * ueber den [PlaybackController] (dessen Start prueft Zustand, Pause,
 * aktiven Stand und Laufzeitgueltigkeit erneut). Kein Dienst, kein zweiter
 * Scheduler, keine Datenloeschung.
 *
 * Ein ausgeschoepftes Budget oder ein gescheiterter Versuch wird als
 * technischer Zustand gemeldet ([onFault]), nie als erfolgreiche Wiedergabe.
 */
class PlaybackWatchdogMonitor(
    private val controller: PlaybackController,
    private val state: () -> StateSnapshot?,
    private val watchdog: PlaybackWatchdog,
    private val schedule: (delayMs: Long, action: () -> Unit) -> AutoCloseable,
    private val onFault: (Boolean) -> Unit = {},
    private val intervalMs: Long = DEFAULT_INTERVAL_MS,
) {
    private var running = false
    private var task: AutoCloseable? = null
    private var fault = false

    /** Letztes Pruefergebnis; nur fuer Diagnose. */
    @Volatile
    var lastOutcome: WatchdogOutcome? = null
        private set

    /** Genau ein Monitor je Lebenszyklus; wiederholte Aufrufe sind wirkungslos. */
    @Synchronized
    fun start() {
        if (running) return
        running = true
        plan()
    }

    /** Bricht das Monitoring vollstaendig ab; danach kein Timer. */
    @Synchronized
    fun stop() {
        running = false
        task?.close()
        task = null
    }

    @Synchronized
    fun hasScheduledCheck(): Boolean = task != null

    private fun plan() {
        task?.close()
        task = schedule(intervalMs) { tick() }
    }

    internal fun tick() {
        synchronized(this) {
            task = null
            if (!running) return
        }
        val snapshot = state()
        val outcome = if (snapshot == null) {
            null
        } else {
            watchdog.check(
                snapshot,
                controller.currentPlanning(),
                controller.progressSample() ?: PlaybackProgress(0L, 0L),
            )
        }
        lastOutcome = outcome
        val nowFault = when (outcome?.status) {
            WatchdogStatus.RECOVERY_FAILED, WatchdogStatus.ATTEMPT_LIMIT_REACHED -> true
            WatchdogStatus.PROGRESS, WatchdogStatus.RECOVERED -> false
            else -> fault
        }
        if (nowFault != fault) {
            fault = nowFault
            onFault(nowFault)
        }
        synchronized(this) { if (running) plan() }
    }

    companion object {
        const val DEFAULT_INTERVAL_MS = 10_000L
    }
}
