package gtads.device.control

/**
 * Lokaler Befehlsanwendungskern fuer R-905.
 *
 * Der Dienst nimmt ausschliesslich bereits authentifiziert abgeholte
 * Befehle entgegen. Er validiert Bindung und Felder, vergibt keine
 * Netzwerkabholung und enthaelt keine Fahrer-UI.
 */
class DeviceControlService(
    private val store: DeviceControlStore,
    private val binding: DeviceBinding,
    private val clock: () -> Long = System::currentTimeMillis,
    val stateAdapter: ControlStateAdapter = ControlStateAdapter(store, clock),
) : AutoCloseable {

    fun apply(command: DeviceControlCommand): DeviceControlApplyResult {
        if (command.deviceId != binding.deviceId || command.taxiId != binding.taxiId) {
            return DeviceControlApplyResult.Rejected(DeviceControlRejection.FOREIGN_BINDING)
        }
        val commandId = canonicalUuid(command.commandId)
            ?: return DeviceControlApplyResult.Rejected(DeviceControlRejection.INVALID_COMMAND)
        if (command.revision < 1L ||
            command.revision > ControlConfigValues.MAX_SAFE_INTEGER
        ) {
            return DeviceControlApplyResult.Rejected(DeviceControlRejection.INVALID_COMMAND)
        }

        val validated = when (command) {
            is DeviceControlCommand.SetPause -> ValidatedCommand(
                commandId = commandId,
                deviceId = binding.deviceId,
                taxiId = binding.taxiId,
                revision = command.revision,
                kind = CommandKind.Pause,
                desiredPaused = command.desiredPaused,
                config = null,
            )
            is DeviceControlCommand.Configure -> {
                val config = command.config
                if (config.gpsMode != ControlConfigValues.GPS_OFF) {
                    return DeviceControlApplyResult.Rejected(
                        DeviceControlRejection.GPS_NOT_DISABLED,
                    )
                }
                if (!isValidConfig(config)) {
                    return DeviceControlApplyResult.Rejected(DeviceControlRejection.INVALID_COMMAND)
                }
                ValidatedCommand(
                    commandId = commandId,
                    deviceId = binding.deviceId,
                    taxiId = binding.taxiId,
                    revision = command.revision,
                    kind = CommandKind.Config,
                    desiredPaused = null,
                    config = config,
                )
            }
        }

        return when (val outcome = store.apply(binding, validated, clock())) {
            is StoreApplyResult.Applied -> {
                stateAdapter.publish()
                DeviceControlApplyResult.Applied(
                    acknowledgement = outcome.acknowledgement,
                    duplicate = outcome.duplicate,
                )
            }
            is StoreApplyResult.Older -> DeviceControlApplyResult.IgnoredOlder(
                outcome.currentRevision,
            )
            is StoreApplyResult.Rejected -> DeviceControlApplyResult.Rejected(
                when (outcome.reason) {
                    StoreRejection.BindingMismatch -> DeviceControlRejection.FOREIGN_BINDING
                    StoreRejection.CommandIdConflict -> DeviceControlRejection.COMMAND_ID_CONFLICT
                    StoreRejection.RevisionConflict -> DeviceControlRejection.REVISION_CONFLICT
                },
            )
            StoreApplyResult.Failure -> DeviceControlApplyResult.StorageFailure
        }
    }

    /**
     * Ein lokaler Standard darf keine bereits angewandte Fernpause
     * ueberschreiben. Das Ergebnis sagt dem Aufrufer, ob er den lokalen
     * Standard ueberhaupt setzen durfte.
     */
    fun applyLocalDefaultPaused(paused: Boolean): LocalDefaultResult {
        val result = when (store.applyLocalDefaultPaused(binding, paused, clock())) {
            StoreLocalDefaultResult.Applied -> LocalDefaultResult.APPLIED
            StoreLocalDefaultResult.BlockedByRemote -> LocalDefaultResult.BLOCKED_BY_REMOTE_PAUSE
            StoreLocalDefaultResult.Failure -> LocalDefaultResult.STORAGE_FAILURE
        }
        if (result == LocalDefaultResult.APPLIED) {
            stateAdapter.publish()
        }
        return result
    }

    /** Nur nach erfolgreichem Commit vorhandene Quittungen. */
    fun pendingAcknowledgements(): List<PendingAcknowledgement> =
        store.pendingAcknowledgements()

    /** Erst nach erfolgreicher HTTP-Quittierung aufrufen. */
    fun acknowledgeDelivered(commandId: String): Boolean {
        val canonical = canonicalUuid(commandId) ?: return false
        return store.markAcknowledged(canonical)
    }

    fun effectiveState(vehicleOff: Boolean = false): EffectiveControlState =
        stateAdapter.current(vehicleOff)

    override fun close() {
        store.close()
    }

    private fun isValidConfig(config: ControlConfigValues): Boolean {
        val maxDuration = config.pauseMaxDurationS
        if (maxDuration != null &&
            (maxDuration <= 0L || maxDuration > ControlConfigValues.MAX_SAFE_INTEGER)
        ) {
            return false
        }
        val displayRunOn = config.displayRunOnS
        if (displayRunOn != null &&
            (displayRunOn < 0L || displayRunOn > ControlConfigValues.MAX_SAFE_INTEGER)
        ) {
            return false
        }
        return true
    }
}
