package gtads.device.watchdog

import gtads.device.playback.PlaybackDecision
import gtads.device.state.StateSnapshot

/**
 * Bereinigter technischer Fehlercode eines Wiederherstellungsversuchs.
 *
 * Der Kern gibt niemals Exception-Texte, Stacktraces oder Playerdetails nach
 * aussen weiter. Aufrufer erhalten ausschliesslich diese festen Codes.
 */
enum class RecoveryFailureCode {
    /** Der bestehende Player konnte nicht neu gestartet werden. */
    PLAYBACK_RESTART_FAILED,

    /** Fuer die Wiederherstellung war kein nutzbarer Player vorhanden. */
    PLAYER_UNAVAILABLE,

    /** Der Adapter ist unerwartet gescheitert; Details bleiben im Adapter. */
    UNEXPECTED,
}

/** Ergebnis genau eines Wiederherstellungsversuchs. */
sealed interface RecoveryResult {
    /** Die Wiederherstellung wurde ohne Fehler angestossen. */
    data object Recovered : RecoveryResult

    /** Die Wiederherstellung ist gescheitert; [code] ist bereits bereinigt. */
    data class Failed(val code: RecoveryFailureCode) : RecoveryResult
}

/**
 * Injizierbarer Wiederherstellungsadapter (F-A10/F-A11).
 *
 * Der Watchdog kennt weder Player noch Activity. Ein Versuch wird immer
 * serialisiert aufgerufen; der Adapter darf deshalb genau eine bestehende
 * Wiedergabeschleife neu anstossen.
 */
fun interface PlaybackRecovery {
    fun recover(): RecoveryResult
}

/**
 * Grenzen und Fristen des Watchdogs.
 *
 * Standardwerte:
 * - 60 Sekunden ohne Fortschritt loesen einen Versuch aus;
 * - hoechstens drei Versuche innerhalb von zehn Minuten;
 * - mindestens 30 Sekunden zwischen zwei Versuchen;
 * - nach zehn Minuten nachgewiesen gesunden Betriebs wird der Zaehler
 *   zurueckgesetzt.
 *
 * Alle Zeiten beziehen sich auf die injizierte monotone Uhr in Millisekunden.
 */
data class WatchdogConfig(
    val progressTimeoutMillis: Long = 60_000L,
    val maxAttemptsPerWindow: Int = 3,
    val attemptWindowMillis: Long = 600_000L,
    val minAttemptIntervalMillis: Long = 30_000L,
    val healthyResetMillis: Long = 600_000L,
) {
    init {
        require(progressTimeoutMillis > 0L) {
            "progressTimeoutMillis muss positiv sein"
        }
        require(maxAttemptsPerWindow > 0) {
            "maxAttemptsPerWindow muss positiv sein"
        }
        require(attemptWindowMillis > 0L) {
            "attemptWindowMillis muss positiv sein"
        }
        require(minAttemptIntervalMillis >= 0L) {
            "minAttemptIntervalMillis darf nicht negativ sein"
        }
        require(healthyResetMillis > 0L) {
            "healthyResetMillis muss positiv sein"
        }
    }
}

/**
 * Beobachteter Wiedergabefortschritt aus dem bestehenden Player.
 *
 * Der Watchdog erzeugt keinen eigenen Playerzustand. [generation] wechselt bei
 * einer neuen Wiedergabe, [positionMillis] ist die monotone Position des
 * laufenden Mediums. Jede Aenderung eines der beiden Werte gilt als Fortschritt.
 */
data class PlaybackProgress(
    val generation: Long,
    val positionMillis: Long,
) {
    init {
        require(generation >= 0L) { "generation darf nicht negativ sein" }
        require(positionMillis >= 0L || positionMillis == UNKNOWN_POSITION) { "positionMillis darf nicht negativ sein" }
    }

    /** REV-199: Der Player kennt seine Position nicht (Port meldet -1) - fehlende Messung, kein Wert. */
    val positionUnknown: Boolean get() = positionMillis == UNKNOWN_POSITION

    companion object {
        const val UNKNOWN_POSITION = -1L
    }
}

/** Klassifiziertes Ergebnis einer Watchdog-Pruefung. */
enum class WatchdogStatus {
    /** Zustandsautomat oder lokale Planung erlauben keine Pruefung. */
    INACTIVE,

    /** Seit der letzten Pruefung wurde Wiedergabefortschritt beobachtet. */
    PROGRESS,

    /** Wiedergabe ist erlaubt, die Fortschrittsfrist ist aber noch nicht erreicht. */
    WAITING,

    /** Genau ein Wiederherstellungsversuch wurde erfolgreich angestossen. */
    RECOVERED,

    /** Genau ein Wiederherstellungsversuch wurde angestossen und ist gescheitert. */
    RECOVERY_FAILED,

    /** Ein anderer Versuch laeuft bereits; es wurde kein zweiter gestartet. */
    ATTEMPT_RUNNING,

    /** Die Mindestpause zwischen zwei Versuchen ist noch nicht erreicht. */
    ATTEMPT_THROTTLED,

    /** Die Versuchsobergrenze im Zeitfenster ist erreicht. */
    ATTEMPT_LIMIT_REACHED,
}

/**
 * Ergebnis einer Pruefung inklusive der im aktuellen Fenster gezaehlten
 * Versuche. [attemptNumber] und [failureCode] sind nur bei tatsaechlich
 * ausgefuehrten Versuchen gesetzt.
 */
data class WatchdogOutcome(
    val status: WatchdogStatus,
    val attemptsInWindow: Int,
    val attemptNumber: Int? = null,
    val failureCode: RecoveryFailureCode? = null,
)

/**
 * Begrenzter, lokal testbarer Wiedergabe-Watchdog (CX-088 / R-906).
 *
 * Der Kern prueft Wiedergabefortschritt ausschliesslich dann, wenn der
 * bestehende Zustandsautomat (CX-083) Wiedergabe erlaubt und eine gueltige
 * lokale Planung (CX-080) vorliegt. Pause, Fahrzeug-aus und fehlende Planung
 * setzen den Fortschrittsbezug zurueck, loesen aber nie eine Wiederherstellung
 * aus. Nach einer Unterbrechung muss deshalb wieder die volle Frist verstreichen.
 *
 * Versuche sind serialisiert: waehrend ein Adapter laeuft, meldet jede
 * parallele Pruefung [WatchdogStatus.ATTEMPT_RUNNING] und startet keinen
 * zweiten Versuch. Fehler des Adapters werden zu [RecoveryFailureCode]
 * bereinigt. Es gibt bewusst keine periodische Android-Ausfuehrung; der
 * Aufrufer entscheidet, wann [check] ausgefuehrt wird.
 */
class PlaybackWatchdog(
    private val recovery: PlaybackRecovery,
    private val config: WatchdogConfig = WatchdogConfig(),
    private val clock: () -> Long = { System.nanoTime() / 1_000_000L },
) {
    private sealed interface Action {
        data class Done(val outcome: WatchdogOutcome) : Action
        data class Attempt(val attemptNumber: Int) : Action
    }

    private val lock = Any()
    private val attempts = ArrayList<Long>()
    private var lastProgress: PlaybackProgress? = null
    private var lastProgressAt = 0L
    private var healthySince: Long? = null
    private var attemptInFlight = false
    private var lastNow: Long? = null

    /**
     * Wertet eine Probe aus. [planning] stammt aus dem bestehenden Planer;
     * [progress] aus dem bestehenden Player. Der Kern liest selbst weder
     * Player noch Manifest.
     */
    fun check(
        state: StateSnapshot,
        planning: PlaybackDecision,
        progress: PlaybackProgress,
    ): WatchdogOutcome {
        val action = synchronized(lock) {
            val now = monotonicNow()
            pruneAttempts(now)
            if (!state.playbackAllowed || planning !is PlaybackDecision.Play) {
                // Kein technischer Fehler: Pause, Fahrzeug-aus und fehlende
                // Planung sind legitime Gruende fuer keine Wiedergabe.
                lastProgress = null
                healthySince = null
                Action.Done(WatchdogOutcome(WatchdogStatus.INACTIVE, attempts.size))
            } else {
                evaluate(now, progress)
            }
        }
        return when (val pending = action) {
            is Action.Done -> pending.outcome
            is Action.Attempt -> runAttempt(pending.attemptNumber)
        }
    }

    private fun evaluate(now: Long, progress: PlaybackProgress): Action {
        val previous = lastProgress
        if (progress.positionUnknown && previous != null && previous.generation == progress.generation) {
            // REV-199: unbekannte Position ist eine fehlende Messung - weder Fortschritt noch Stillstand.
            // Kein Wiederherstellungsversuch und kein Budgetverbrauch allein wegen fehlender Messwerte.
            lastProgressAt = now
            return Action.Done(WatchdogOutcome(WatchdogStatus.WAITING, attempts.size))
        }
        if (previous == null || previous != progress) {
            lastProgress = progress
            lastProgressAt = now
            val healthyStart = healthySince
            if (healthyStart == null) {
                healthySince = now
            } else if (now - healthyStart >= config.healthyResetMillis) {
                // Zehn Minuten durchgehend belegter Fortschritt: der alte
                // Fehlerzaehler ist nicht mehr relevant.
                attempts.clear()
                healthySince = now
            }
            return Action.Done(WatchdogOutcome(WatchdogStatus.PROGRESS, attempts.size))
        }

        if (now - lastProgressAt < config.progressTimeoutMillis) {
            return Action.Done(WatchdogOutcome(WatchdogStatus.WAITING, attempts.size))
        }
        if (attemptInFlight) {
            return Action.Done(WatchdogOutcome(WatchdogStatus.ATTEMPT_RUNNING, attempts.size))
        }
        if (attempts.size >= config.maxAttemptsPerWindow) {
            return Action.Done(WatchdogOutcome(WatchdogStatus.ATTEMPT_LIMIT_REACHED, attempts.size))
        }
        val lastAttempt = attempts.lastOrNull()
        if (lastAttempt != null && now - lastAttempt < config.minAttemptIntervalMillis) {
            return Action.Done(WatchdogOutcome(WatchdogStatus.ATTEMPT_THROTTLED, attempts.size))
        }

        attempts.add(now)
        attemptInFlight = true
        healthySince = null
        return Action.Attempt(attempts.size)
    }

    private fun runAttempt(attemptNumber: Int): WatchdogOutcome {
        val result = try {
            recovery.recover()
        } catch (_: Exception) {
            RecoveryResult.Failed(RecoveryFailureCode.UNEXPECTED)
        } finally {
            synchronized(lock) {
                attemptInFlight = false
            }
        }
        val count = synchronized(lock) { attempts.size }
        return when (result) {
            RecoveryResult.Recovered -> WatchdogOutcome(
                status = WatchdogStatus.RECOVERED,
                attemptsInWindow = count,
                attemptNumber = attemptNumber,
            )
            is RecoveryResult.Failed -> WatchdogOutcome(
                status = WatchdogStatus.RECOVERY_FAILED,
                attemptsInWindow = count,
                attemptNumber = attemptNumber,
                failureCode = result.code,
            )
        }
    }

    private fun pruneAttempts(now: Long) {
        attempts.removeAll { attempt -> now - attempt >= config.attemptWindowMillis }
    }

    /** Klemmt Rueckwaertsspruenge der injizierten Uhr auf den letzten Stand. */
    private fun monotonicNow(): Long {
        val raw = clock()
        val previous = lastNow
        val now = if (previous != null && raw < previous) previous else raw
        lastNow = now
        return now
    }
}
