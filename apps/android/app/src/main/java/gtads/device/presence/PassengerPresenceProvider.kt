package gtads.device.presence

/**
 * Ergebnis einer Presence-Abfrage (F-A29).
 *
 * Die Schnittstelle ist absichtlich klein und austauschbar. Presence bleibt im
 * MVP wirkungslos; es gibt keine Kamera-, Mikrofon- oder sonstige Sensorik.
 */
enum class PresenceReading {
    /** Keine Presence-Sensorik vorhanden oder freigegeben. */
    UNAVAILABLE,

    /** Eine spaetere, ausdruecklich freigegebene Sensorik meldet Anwesenheit. */
    PRESENT,

    /** Eine spaetere, ausdruecklich freigegebene Sensorik meldet Abwesenheit. */
    ABSENT,
}

/**
 * Austauschbare Presence-Schnittstelle (F-A29).
 *
 * [remoteRuleEnabled] bildet eine spaetere Fernkonfiguration ab. Der
 * Nulladapter ignoriert den Wert und liefert immer [PresenceReading.UNAVAILABLE].
 */
interface PassengerPresenceProvider {
    fun read(remoteRuleEnabled: Boolean = false): PresenceReading
}

/**
 * Produktiver Nulladapter fuer das MVP.
 *
 * Er greift auf keinen Sensor zu, fordert keine Berechtigung an, speichert
 * keine Daten und laesst sich durch Fernkonfiguration nicht aktivieren.
 */
class NullPassengerPresenceProvider : PassengerPresenceProvider {
    override fun read(remoteRuleEnabled: Boolean): PresenceReading =
        PresenceReading.UNAVAILABLE
}
