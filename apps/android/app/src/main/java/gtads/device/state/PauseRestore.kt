package gtads.device.state

/** Zustand der lokalen Initialisierungsbarriere (CX-100 / R-905). */
sealed interface PauseRestoreState {
    /** Persistenter Pausenzustand noch nicht geladen: Barriere geschlossen. */
    data object Pending : PauseRestoreState

    /** Laden fehlgeschlagen: Barriere bleibt geschlossen, kontrollierte Wiederholung moeglich. */
    data object Failed : PauseRestoreState

    /** Gespeicherter wirksamer Pausenzustand ist geladen und angewandt. */
    data class Loaded(val paused: Boolean) : PauseRestoreState
}

/**
 * Laedt den vorhandenen persistenten Pausenzustand (CX-086) genau einmal je
 * Anstoss. Die Wiederherstellung ist kein Fernbefehl: es wird nichts
 * geschrieben, nichts quittiert und keine Revision veraendert. Nach einem
 * Fehler gibt es keine Dauerschleife; [retry] wird nur von einem vorhandenen
 * Ausloeser (Lifecycle-Start, Neubewertung) aufgerufen.
 *
 * @param read liest den wirksamen Pausenzustand aus dem lokalen Speicher
 * @param execute fuehrt das Lesen asynchron aus (Produktion: Hintergrund-Executor)
 * @param onChange meldet jede Zustandsaenderung (z. B. Neubewertung des Koordinators)
 */
class PauseRestore(
    private val read: () -> Boolean,
    private val execute: (() -> Unit) -> Unit,
    private val onChange: () -> Unit = {},
) {
    @Volatile
    private var state: PauseRestoreState = PauseRestoreState.Pending
    private var loading = false
    private var attempt = 0L

    fun state(): PauseRestoreState = state

    /** Startet das Laden, falls noch nicht geladen und kein Ladevorgang laeuft. */
    @Synchronized
    fun ensureLoaded() {
        if (state is PauseRestoreState.Loaded || loading) return
        loading = true
        val current = ++attempt
        execute {
            val next = try {
                PauseRestoreState.Loaded(read())
            } catch (_: Exception) {
                PauseRestoreState.Failed
            }
            synchronized(this) {
                // Ein veralteter Ladevorgang ueberschreibt keinen neueren Stand.
                if (current != attempt) return@execute
                loading = false
                state = next
            }
            onChange()
        }
    }

    /** Kontrollierte Wiederholung nach einem Fehler; wirkungslos in allen anderen Zustaenden. */
    @Synchronized
    fun retry() {
        if (state is PauseRestoreState.Failed && !loading) ensureLoaded()
    }

    /** Nach dem erfolgreichen Laden: spaetere lokale Pausenwechsel (CX-087) uebernehmen. */
    @Synchronized
    fun update(paused: Boolean) {
        if (state is PauseRestoreState.Loaded) state = PauseRestoreState.Loaded(paused)
    }
}
