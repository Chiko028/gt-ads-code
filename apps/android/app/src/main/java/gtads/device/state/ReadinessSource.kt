package gtads.device.state

/**
 * Austauschbare Quelle der Fahrzeugbereitschaft (R-904).
 *
 * Die Quelle liefert unknown/on/off und meldet Aenderungen waehrend des
 * aktiven App-Lifecycles. Sie beschreibt ausschliesslich eine technische
 * Bereitschaft, keine Fahrzeugzuendung.
 */
interface ReadinessSource {
    /** Aktueller Stand; ohne verfuegbares Signal [VehicleReadiness.UNKNOWN]. */
    fun current(): VehicleReadiness

    /**
     * Registriert genau einen Beobachter und ersetzt einen frueheren.
     * Wiederholte Aufrufe erzeugen keine zweite Registrierung.
     */
    fun start(observer: (VehicleReadiness) -> Unit)

    /** Meldet den Beobachter ab; mehrfach aufrufbar. */
    fun stop()
}
