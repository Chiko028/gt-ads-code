package gtads.device.location

/**
 * GPS-Modi aus F-A17.
 *
 * Die Nutzung ist bis zu einer ausdruecklichen Freigabe gesperrt. Der
 * Nulladapter liefert ausschliesslich [OFF]; die uebrigen Werte sind nur die
 * geschlossene Schnittstelle fuer spaetere, separat freizugebende Pakete.
 */
enum class GpsMode {
    /** Standard und einziger im MVP wirksamer Modus. */
    OFF,

    /** Spaetere lokale Gebietserkennung ohne Rohkoordinaten-Upload. */
    LOCAL_AREA_DETECTION,

    /** Spaetere Standortuebermittlung; rechtlich gesperrt. */
    LOCATION_UPLOAD,
}

/** Ein spaeterer Positionswert; der Nulladapter erzeugt niemals einen. */
data class LocationFix(
    val latitude: Double,
    val longitude: Double,
)

/**
 * Minimale, austauschbare GPS-Schnittstelle (F-A17).
 *
 * [remoteGpsMode] ist der optionale Wert aus der Fernkonfiguration. Der
 * Nulladapter aktiviert daraus nie einen Modus. [lastFix] liefert immer null;
 * es werden keine Standortdaten erhoben, gespeichert oder weitergegeben.
 */
interface GpsProvider {
    fun mode(remoteGpsMode: String? = null): GpsMode

    /** Letzte Position; ohne freigegebene Sensorik immer null. */
    fun lastFix(): LocationFix? = null
}

/**
 * Produktiver Nulladapter fuer das MVP.
 *
 * Er greift auf keinen Standortsensor zu, fordert keine Berechtigung an und
 * ignoriert jede Fernkonfiguration. Damit bleibt GPS wirkungslos.
 */
class NullGpsProvider : GpsProvider {
    override fun mode(remoteGpsMode: String?): GpsMode = GpsMode.OFF

    override fun lastFix(): LocationFix? = null
}
