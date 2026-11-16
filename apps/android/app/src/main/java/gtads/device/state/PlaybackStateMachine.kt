package gtads.device.state

/**
 * Deterministischer Zustandsautomat fuer Wiedergabefreigabe und Display-Nachlauf
 * (CX-083 / R-904).
 *
 * Die Eingaben sind unabhaengig voneinander:
 * - Fahrzeugbereitschaft unknown/on/off
 * - wirksame Pause (Fahrer, Betreiber oder auto)
 * - lokal abspielbarer Inhalt
 * - Playerfehler
 * - Netzverfuegbarkeit (nur Statusmerkmal, kein Entscheidungskriterium)
 *
 * Wiedergabe ist nur bei bekannter Bereitschaft ON, ohne Pause, mit gueltigem
 * Inhalt und ohne Playerfehler erlaubt. UNKNOWN blockiert, wird aber nie als
 * Fahrzeug-aus ausgewiesen. Bei OFF stoppt die Wiedergabe sofort; der
 * Displaybedarf endet erst nach dem konfigurierten Nachlauf. Alle Fristen
 * beziehen sich auf die injizierte monotone Uhr.
 */

/** Fahrzeugbereitschaft; UNKNOWN ist ausdruecklich kein Fahrzeug-aus. */
enum class VehicleReadiness {
    UNKNOWN,
    ON,
    OFF,
}

/** Ob lokal ein gueltiger, abspielbarer Inhalt vorliegt. */
enum class ContentAvailability {
    VALID,
    NONE,
}

/** Playerzustand; ein Fehler verhindert Wiedergabe, hebt aber keinen Nachlauf auf. */
enum class PlayerCondition {
    OK,
    ERROR,
}

/** Netzverfuegbarkeit als reines Statusmerkmal ohne Einfluss auf die Entscheidung. */
enum class NetworkStatus {
    AVAILABLE,
    UNAVAILABLE,
}

/** Eindeutig klassifizierter Grund der Entscheidung, in fester Vorrangreihenfolge. */
enum class DecisionReason {
    /** Bereitschaft ON, keine Pause, gueltiger Inhalt, kein Playerfehler. */
    PLAYING,

    /** Bereitschaft unbekannt: keine Wiedergabe, aber auch kein Fahrzeug-aus. */
    VEHICLE_UNKNOWN,

    /** Bereitschaft OFF: Wiedergabe sofort gesperrt. */
    VEHICLE_OFF,

    /** Wirksame Pause blockiert die Wiedergabe. */
    PAUSED,

    /** Kein lokal abspielbarer Inhalt. */
    NO_VALID_CONTENT,

    /** Playerfehler blockiert die Wiedergabe. */
    PLAYER_ERROR,
}

/** Standard-Nachlauf bis zum Ende des Displaybedarfs: 120 Sekunden. */
const val DEFAULT_DISPLAY_GRACE_MILLIS: Long = 120_000L

/**
 * Konfiguration des Automaten.
 *
 * @param displayGraceMillis Nachlauf bis zum Ende des Displaybedarfs nach
 *   Fahrzeug-aus; Standard 120 Sekunden.
 * @param resetPauseOnVehicleOff ob eine wirksame Pause beim Fahrzeug-aus
 *   aufgehoben wird; Standard false, damit eine Fernpause nicht unbemerkt
 *   verschwindet.
 */
data class StateMachineConfig(
    val displayGraceMillis: Long = DEFAULT_DISPLAY_GRACE_MILLIS,
    val resetPauseOnVehicleOff: Boolean = false,
) {
    init {
        require(displayGraceMillis >= 0L) { "displayGraceMillis darf nicht negativ sein" }
    }
}

/** Vollstaendige Eingabe einer Auswertung. */
data class StateInput(
    val vehicle: VehicleReadiness,
    val pauseActive: Boolean,
    val content: ContentAvailability,
    val player: PlayerCondition,
    val network: NetworkStatus = NetworkStatus.AVAILABLE,
)

/**
 * Ergebnis einer Auswertung.
 *
 * @param playbackAllowed Wiedergabefreigabe.
 * @param displayRequired ob das Display aktuell benoetigt wird.
 * @param reason eindeutiger Grund der Entscheidung.
 * @param pauseEffective wirksame Pause nach einer eventuellen Resetsemantik.
 * @param network durchgereichtes Statusmerkmal, kein Entscheidungskriterium.
 * @param transitions Anzahl der tatsaechlichen Zustandswechsel seit Beginn;
 *   wiederholte gleiche Eingaben erhoehen den Wert nicht.
 */
data class StateSnapshot(
    val playbackAllowed: Boolean,
    val displayRequired: Boolean,
    val reason: DecisionReason,
    val pauseEffective: Boolean,
    val network: NetworkStatus,
    val transitions: Long,
)

/**
 * Zustandsbehafteter, deterministischer Automat.
 *
 * Die Pause wird flankengesteuert uebernommen: nur ein Wechsel der
 * Pauseneingabe aendert den gespeicherten Pausenzustand. Dadurch erzeugt eine
 * wiederholte identische Eingabe keinen zweiten Uebergang. Bei aktivierter
 * Pausenruecksetzung wird die Pause beim Fahrzeug-aus geloescht; eine
 * unveraenderte Pauseneingabe kann sie danach nicht erneut setzen, erst eine
 * neue Flanke (Pause aus, dann wieder an) wirkt wieder.
 *
 * Ein Rueckwaertssprung der injizierten Uhr wird auf den letzten Stand
 * geklemmt, damit eine Frist nicht neu startet.
 *
 * @param clock monotone Zeitquelle in Millisekunden; im Produktivbetrieb
 *   System.nanoTime(), in Tests eine kontrollierte Uhr.
 */
class PlaybackStateMachine(
    private val config: StateMachineConfig = StateMachineConfig(),
    private val clock: () -> Long = { System.nanoTime() / 1_000_000L },
) {
    private var lastNowMillis: Long? = null
    private var previousVehicle: VehicleReadiness? = null
    private var offSinceMillis: Long? = null
    private var pauseLatched = false
    private var previousPauseInput = false
    private var lastSnapshot: StateSnapshot? = null
    private var transitionCount = 0L

    /** Letzte Entscheidung oder null, solange noch nicht ausgewertet wurde. */
    fun snapshot(): StateSnapshot? = lastSnapshot

    /** Wertet eine Eingabe aus und liefert die reproduzierbare Entscheidung. */
    fun evaluate(input: StateInput): StateSnapshot {
        val now = monotonicNow()
        val previous = previousVehicle
        previousVehicle = input.vehicle

        if (input.vehicle == VehicleReadiness.OFF) {
            if (previous != VehicleReadiness.OFF) {
                offSinceMillis = now
            }
        } else {
            offSinceMillis = null
        }

        if (input.pauseActive != previousPauseInput) {
            pauseLatched = input.pauseActive
            previousPauseInput = input.pauseActive
        }
        if (input.vehicle == VehicleReadiness.OFF && config.resetPauseOnVehicleOff) {
            pauseLatched = false
        }

        val reason = when {
            input.vehicle == VehicleReadiness.OFF -> DecisionReason.VEHICLE_OFF
            input.vehicle == VehicleReadiness.UNKNOWN -> DecisionReason.VEHICLE_UNKNOWN
            pauseLatched -> DecisionReason.PAUSED
            input.content == ContentAvailability.NONE -> DecisionReason.NO_VALID_CONTENT
            input.player == PlayerCondition.ERROR -> DecisionReason.PLAYER_ERROR
            else -> DecisionReason.PLAYING
        }
        val playbackAllowed = reason == DecisionReason.PLAYING

        val displayRequired = if (input.vehicle != VehicleReadiness.OFF) {
            true
        } else {
            val since = offSinceMillis ?: now
            now - since < config.displayGraceMillis
        }

        val previousSnapshot = lastSnapshot
        val changed = previousSnapshot == null ||
            previousSnapshot.playbackAllowed != playbackAllowed ||
            previousSnapshot.displayRequired != displayRequired ||
            previousSnapshot.reason != reason ||
            previousSnapshot.pauseEffective != pauseLatched
        if (changed && previousSnapshot != null) {
            transitionCount += 1L
        }

        val snapshot = StateSnapshot(
            playbackAllowed = playbackAllowed,
            displayRequired = displayRequired,
            reason = reason,
            pauseEffective = pauseLatched,
            network = input.network,
            transitions = transitionCount,
        )
        lastSnapshot = snapshot
        return snapshot
    }

    private fun monotonicNow(): Long {
        val raw = clock()
        val previous = lastNowMillis
        val now = if (previous != null && raw < previous) previous else raw
        lastNowMillis = now
        return now
    }
}
