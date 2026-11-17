package gtads.device.control

import java.util.Locale

/**
 * Lokal bereits authentifiziert abgeholte Befehle fuer R-905.
 *
 * Die Feldnamen folgen den vorhandenen Vertraegen:
 * - Pause/Fortsetzen: CX-052/CX-054 mit command_id, revision und
 *   desired_paused.
 * - Konfiguration: CX-013 mit gps_mode, pause_max_duration_s,
 *   pause_end_on_vehicle_off und display_run_on_s.
 *
 * CX-054 liefert im GET /v1/device/commands ausschliesslich command_id,
 * revision und desired_paused. issued_at oder expires_at sind nicht Teil
 * dieses Vertrags. Der lokale Kern erfindet deshalb keine Ablaufzeit; die
 * Reihenfolge kommt ausschliesslich aus der monotonen Revision und niemals
 * aus der lexikografischen UUID-Reihenfolge.
 */
sealed interface DeviceControlCommand {
    val commandId: String
    val deviceId: String
    val taxiId: String
    val revision: Long

    data class SetPause(
        override val commandId: String,
        override val deviceId: String,
        override val taxiId: String,
        override val revision: Long,
        val desiredPaused: Boolean,
    ) : DeviceControlCommand

    data class Configure(
        override val commandId: String,
        override val deviceId: String,
        override val taxiId: String,
        override val revision: Long,
        val config: ControlConfigValues,
    ) : DeviceControlCommand
}

/** Authentifizierte lokale Geraete- und Taxibindung. */
data class DeviceBinding(
    val deviceId: String,
    val taxiId: String,
) {
    init {
        require(deviceId.isNotBlank()) { "deviceId must not be blank" }
        require(taxiId.isNotBlank()) { "taxiId must not be blank" }
    }
}

/**
 * Die vier versionierten CX-013-Konfigurationsfelder.
 *
 * Die Klasse ist absichtlich ein geschlossener Wert: unbekannte Felder
 * koennen nur ueber [fromWire] eintreten und werden dort abgewiesen.
 */
data class ControlConfigValues(
    val gpsMode: String,
    val pauseMaxDurationS: Long?,
    val pauseEndOnVehicleOff: Boolean?,
    val displayRunOnS: Long?,
) {
    companion object {
        const val GPS_OFF: String = "aus"
        const val MAX_SAFE_INTEGER: Long = 9_007_199_254_740_991L

        private val WIRE_KEYS = setOf(
            "gps_mode",
            "pause_max_duration_s",
            "pause_end_on_vehicle_off",
            "display_run_on_s",
        )

        /**
         * Liest genau die vier erlaubten CX-013-Felder. Unbekannte oder
         * fehlende Felder sowie GPS ungleich "aus" werden abgewiesen.
         */
        fun fromWire(fields: Map<String, Any?>): ControlConfigValues {
            val unknown = fields.keys - WIRE_KEYS
            require(unknown.isEmpty()) {
                "unbekannte Konfigurationsfelder: " + unknown.sorted().joinToString(",")
            }
            val missing = WIRE_KEYS - fields.keys
            require(missing.isEmpty()) {
                "fehlende Konfigurationsfelder: " + missing.sorted().joinToString(",")
            }
            val gps = fields["gps_mode"]
            require(gps == GPS_OFF) { "gps_mode ist ausschliesslich 'aus'" }
            return ControlConfigValues(
                gpsMode = GPS_OFF,
                pauseMaxDurationS = positiveLongOrNull(
                    fields["pause_max_duration_s"],
                    "pause_max_duration_s",
                ),
                pauseEndOnVehicleOff = booleanOrNull(
                    fields["pause_end_on_vehicle_off"],
                    "pause_end_on_vehicle_off",
                ),
                displayRunOnS = nonNegativeLongOrNull(
                    fields["display_run_on_s"],
                    "display_run_on_s",
                ),
            )
        }

        private fun positiveLongOrNull(value: Any?, field: String): Long? {
            val parsed = longOrNull(value, field) ?: return null
            require(parsed > 0L) { field + " muss positiv sein" }
            return parsed
        }

        private fun nonNegativeLongOrNull(value: Any?, field: String): Long? {
            val parsed = longOrNull(value, field) ?: return null
            require(parsed >= 0L) { field + " darf nicht negativ sein" }
            return parsed
        }

        private fun longOrNull(value: Any?, field: String): Long? {
            if (value == null) return null
            val number = value as? Number
                ?: throw IllegalArgumentException(field + " muss eine Zahl oder null sein")
            val asDouble = number.toDouble()
            require(!asDouble.isNaN() && !asDouble.isInfinite()) {
                field + " muss eine endliche Zahl sein"
            }
            require(asDouble == Math.floor(asDouble)) {
                field + " muss eine Ganzzahl sein"
            }
            require(asDouble <= MAX_SAFE_INTEGER.toDouble()) {
                field + " muss eine sichere Ganzzahl sein"
            }
            return number.toLong()
        }

        private fun booleanOrNull(value: Any?, field: String): Boolean? {
            if (value == null) return null
            return value as? Boolean
                ?: throw IllegalArgumentException(field + " muss ein Boolean oder null sein")
        }
    }
}

/** Nur fuer den Dienst sichtbare, validierte und kanonisierte Befehlsform. */
internal enum class CommandKind(val wire: String) {
    Pause("pause"),
    Config("config"),
}

internal data class ValidatedCommand(
    val commandId: String,
    val deviceId: String,
    val taxiId: String,
    val revision: Long,
    val kind: CommandKind,
    val desiredPaused: Boolean?,
    val config: ControlConfigValues?,
)

internal fun canonicalUuid(value: String): String? {
    if (!UUID_PATTERN.matches(value)) return null
    return value.lowercase(Locale.ROOT)
}

private val UUID_PATTERN = Regex(
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-" +
        "[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
)
