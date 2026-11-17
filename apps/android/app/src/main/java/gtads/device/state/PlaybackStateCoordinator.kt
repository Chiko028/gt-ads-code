package gtads.device.state

/** CX-099: Standardintervall des periodischen Statusberichts (30 Minuten, wie U5). */
const val DEFAULT_PERIODIC_INTERVAL_MILLIS: Long = 30L * 60L * 1_000L

/** Sichtbare Entscheidung des Zustandsautomaten fuer Activity und Player. */
data class GateDecision(
    val playbackAllowed: Boolean,
    val displayRequired: Boolean,
    val reason: DecisionReason,
    val transitions: Long,
)

/** Abbrechbare Zeitplanung des Display-Nachlaufs. */
fun interface ScheduledTask {
    fun cancel()
}

/**
 * Bindet CX-083 an den vorhandenen Activity-/Player-Lifecycle (CX-085 / R-904).
 *
 * Der Koordinator ist die einzige Stelle, die Wiedergabefreigabe und
 * Displaybedarf aus Bereitschaft, Inhalt und Playerzustand ableitet. Er
 * startet keinen Hintergrunddienst und besitzt keine eigene Zeitbasis:
 * Fristen kommen aus dem injizierten [PlaybackStateMachine]-Uhrwerk.
 *
 * - Wiederholter Lifecycle-Start registriert keinen zweiten Beobachter.
 * - Jeder tatsaechliche Zustandswechsel wird genau einmal ueber den
 *   CX-084-Puffer geschrieben.
 * - Speicherfehler werden ueber [storageError] sichtbar, ohne die
 *   Wiedergabeentscheidung zu veraendern.
 * - [stop] meldet Beobachter und Display-Timer ab.
 */
class PlaybackStateCoordinator(
    private val machine: PlaybackStateMachine,
    private val readiness: ReadinessSource,
    private val content: () -> ContentAvailability,
    private val player: () -> PlayerCondition = { PlayerCondition.OK },
    private val recorder: () -> StateChangeRecorder? = { null },
    private val displayGraceMillis: Long = DEFAULT_DISPLAY_GRACE_MILLIS,
    private val schedule: (delayMillis: Long, action: () -> Unit) -> ScheduledTask =
        { _, _ -> ScheduledTask { } },
    private val onDecision: (GateDecision) -> Unit = {},
    private val onStorageError: (String) -> Unit = {},
    /** CX-099: Markierung des letzten gespeicherten periodischen Berichts; null = kein periodischer Bericht. */
    private val periodicMark: PeriodicStatusMark? = null,
    private val periodicIntervalMillis: Long = DEFAULT_PERIODIC_INTERVAL_MILLIS,
    private val wallClock: () -> java.time.Instant = java.time.Instant::now,
    private val newEventId: () -> String = { java.util.UUID.randomUUID().toString() },
) {
    /** Einzige Serialisierungsgrenze fuer Zustandswechsel und periodische Berichte. */
    private val lock = Any()

    /** Noch nicht erfolgreich gespeicherter periodischer Bericht; behaelt seine Ereignis-ID. */
    private class PendingReport(
        val eventId: String,
        val occurredAt: java.time.Instant,
        val snapshot: StateSnapshot,
        val vehicle: VehicleReadiness,
    )

    private var pendingReport: PendingReport? = null
    private var periodicTask: ScheduledTask? = null
    private var started = false
    private var lastDecision: GateDecision? = null
    private var lastRecordedTransitions: Long? = null
    private var displayTask: ScheduledTask? = null
    private var storage: String? = null

    /** Letzter sichtbarer Speicherfehler oder null. */
    val storageError: String?
        get() = storage

    /** Aktuelle Entscheidung oder null, solange nicht gestartet wurde. */
    fun decision(): GateDecision? = lastDecision

    private val observer: (VehicleReadiness) -> Unit = { refresh() }

    /** Startet die Anbindung; wiederholte Aufrufe sind wirkungslos. */
    fun start() = synchronized(lock) {
        if (started) return@synchronized
        started = true
        readiness.start(observer)
        evaluate(notifyAlways = true)
        schedulePeriodic()
    }

    /** Meldet Beobachter und Display-Timer ab; mehrfach aufrufbar. */
    fun stop() = synchronized(lock) {
        if (!started) return@synchronized
        started = false
        cancelDisplayTask()
        cancelPeriodicTask()
        readiness.stop()
    }

    /** Wertet erneut aus, etwa nach einer abgeschlossenen Registrierung. */
    fun refresh() = synchronized(lock) {
        if (!started) return@synchronized
        evaluate(notifyAlways = false)
    }

    /**
     * CX-099: periodischer Ausloeser. Laeuft ueber dieselbe Sperre wie
     * Zustandswechsel: erst wird ein etwaiger Wechsel gespeichert, danach
     * hoechstens ein Bericht des aktuellen Zustands. Verpasste Intervalle
     * werden zu genau einem Bericht zusammengefasst. Ein fehlgeschlagener
     * Insert behaelt seine Ereignis-ID fuer den naechsten Ausloeser; keine
     * enge Wiederholungsschleife.
     */
    fun periodicTick() = synchronized(lock) {
        if (!started) return@synchronized
        evaluate(notifyAlways = false)
        val mark = periodicMark ?: return@synchronized
        val now = wallClock()
        val last = mark.lastStored()
        val due = pendingReport != null || last == null ||
            !now.isBefore(last.plusMillis(periodicIntervalMillis))
        if (!due) return@synchronized
        val pending = pendingReport ?: run {
            val vehicle = readiness.current()
            val snapshot = machine.snapshot() ?: return@synchronized
            PendingReport(newEventId(), now, snapshot, vehicle).also { pendingReport = it }
        }
        try {
            val target = recorder()
            if (target == null) {
                report("kein_geraetebezug")
                return@synchronized
            }
            when (val result = target.record(pending.snapshot, pending.vehicle, pending.eventId, pending.occurredAt)) {
                StateChangeRecordResult.stored, StateChangeRecordResult.duplicate -> {
                    // Erst nach erfolgreichem Commit fortschreiben.
                    mark.markStored(now)
                    pendingReport = null
                }
                else -> report("puffer_" + result.name)
            }
        } catch (error: Throwable) {
            report(error.javaClass.simpleName.ifEmpty { "speicherfehler" })
        }
    }

    private fun schedulePeriodic() {
        if (periodicMark == null) return
        cancelPeriodicTask()
        periodicTask = schedule(periodicIntervalMillis) {
            synchronized(lock) { periodicTask = null }
            periodicTick()
            synchronized(lock) { if (started) schedulePeriodic() }
        }
    }

    private fun cancelPeriodicTask() {
        val task = periodicTask ?: return
        periodicTask = null
        try {
            task.cancel()
        } catch (_: Exception) {
            // Abbruch ist best effort.
        }
    }

    private fun evaluate(notifyAlways: Boolean) {
        val vehicle = readiness.current()
        val snapshot = machine.evaluate(
            StateInput(
                vehicle = vehicle,
                pauseActive = false,
                content = content(),
                player = player(),
            ),
        )
        recordIfChanged(snapshot, vehicle)
        scheduleDisplayEnd(snapshot, vehicle)
        val decision = GateDecision(
            playbackAllowed = snapshot.playbackAllowed,
            displayRequired = snapshot.displayRequired,
            reason = snapshot.reason,
            transitions = snapshot.transitions,
        )
        val previous = lastDecision
        lastDecision = decision
        if (notifyAlways || previous != decision) {
            onDecision(decision)
        }
    }

    /**
     * Der erste ausgewertete Stand ist kein Wechsel. Danach wird pro
     * Transition genau ein Pufferaufruf ausgefuehrt, auch wenn derselbe
     * Zustand erneut ausgewertet oder der Lifecycle neu gestartet wird.
     */
    private fun recordIfChanged(snapshot: StateSnapshot, vehicle: VehicleReadiness) {
        val previous = lastRecordedTransitions
        if (previous == null) {
            lastRecordedTransitions = snapshot.transitions
            return
        }
        if (snapshot.transitions == previous) return
        lastRecordedTransitions = snapshot.transitions
        try {
            val target = recorder()
            if (target == null) {
                report("kein_geraetebezug")
                return
            }
            when (val result = target.record(snapshot, vehicle)) {
                StateChangeRecordResult.stored, StateChangeRecordResult.duplicate -> Unit
                else -> report("puffer_" + result.name)
            }
        } catch (error: Throwable) {
            // Keine Rohdaten und keine Ursachenmeldung nach aussen.
            report(error.javaClass.simpleName.ifEmpty { "speicherfehler" })
        }
    }

    private fun scheduleDisplayEnd(snapshot: StateSnapshot, vehicle: VehicleReadiness) {
        val pending = snapshot.displayRequired &&
            vehicle == VehicleReadiness.OFF &&
            displayGraceMillis > 0L
        if (!pending) {
            cancelDisplayTask()
            return
        }
        if (displayTask != null) return
        displayTask = schedule(displayGraceMillis) {
            displayTask = null
            refresh()
        }
    }

    private fun cancelDisplayTask() {
        val task = displayTask ?: return
        displayTask = null
        try {
            task.cancel()
        } catch (_: Exception) {
            // Ein nicht abbrechbarer Timer darf den Zustandswechsel nicht blockieren.
        }
    }

    private fun report(category: String) {
        storage = category
        try {
            onStorageError(category)
        } catch (_: Exception) {
            // Der Speicherfehler darf die Wiedergabeentscheidung nicht veraendern.
        }
    }
}
