package gtads.device.control

/**
 * Genau das Quittungs-DTO aus CX-054:
 * {"command_id": "...", "revision": 1}.
 */
data class PendingAcknowledgement(
    val commandId: String,
    val revision: Long,
) {
    fun toWire(): Map<String, Any> = linkedMapOf<String, Any>(
        "command_id" to commandId,
        "revision" to revision,
    )
}

/** Oeffentliche, stabile Ablehnungsgruende ohne Rohtexte oder SQL-Details. */
enum class DeviceControlRejection {
    FOREIGN_BINDING,
    INVALID_COMMAND,
    GPS_NOT_DISABLED,
    COMMAND_ID_CONFLICT,
    REVISION_CONFLICT,
}

sealed interface DeviceControlApplyResult {
    data class Applied(
        val acknowledgement: PendingAcknowledgement,
        val duplicate: Boolean,
    ) : DeviceControlApplyResult

    /** Verspaeteter Befehl mit aelterer Revision: keine Wirkung, keine Quittung. */
    data class IgnoredOlder(val currentRevision: Long) : DeviceControlApplyResult

    data class Rejected(val reason: DeviceControlRejection) : DeviceControlApplyResult

    /** Schreiben/Commit fehlgeschlagen: keine Wirkung und keine Erfolgsquittung. */
    data object StorageFailure : DeviceControlApplyResult
}

enum class LocalDefaultResult {
    APPLIED,
    BLOCKED_BY_REMOTE_PAUSE,
    STORAGE_FAILURE,
}
