package gtads.device.control

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

internal sealed interface StoreApplyResult {
    data class Applied(
        val acknowledgement: PendingAcknowledgement,
        val duplicate: Boolean,
    ) : StoreApplyResult

    data class Older(val currentRevision: Long) : StoreApplyResult

    data class Rejected(val reason: StoreRejection) : StoreApplyResult

    data object Failure : StoreApplyResult
}

internal enum class StoreRejection {
    BindingMismatch,
    CommandIdConflict,
    RevisionConflict,
}

internal enum class StoreLocalDefaultResult {
    Applied,
    BlockedByRemote,
    Failure,
}

data class StoredPauseState(
    val paused: Boolean,
    val revision: Long,
    val commandId: String?,
    val appliedAtEpochMillis: Long,
)

data class StoredConfigState(
    val revision: Long,
    val values: ControlConfigValues,
    val commandId: String?,
    val appliedAtEpochMillis: Long,
)

data class StoredControlState(
    val pause: StoredPauseState,
    val config: StoredConfigState?,
)

/**
 * Persistiert wirksamen Pausenzustand, angewandte Befehlsidentitaeten und
 * ausstehende Quittungen atomar ueber eine einzige SQLiteOpenHelper-Datenbank.
 *
 * Die Revision wird ausschliesslich numerisch verglichen. Die Befehls-ID
 * dedupliziert nur; sie ist nie eine Version.
 */
class DeviceControlStore(
    private val helper: SQLiteOpenHelper,
) : AutoCloseable {

    constructor(
        context: Context,
        databaseName: String = DeviceControlDatabase.DEFAULT_DATABASE_NAME,
    ) : this(DeviceControlDatabase(context, databaseName))

    internal fun apply(
        binding: DeviceBinding,
        command: ValidatedCommand,
        nowEpochMillis: Long,
    ): StoreApplyResult {
        var outcome: StoreApplyResult = StoreApplyResult.Failure
        var inTransaction = false
        try {
            val db = helper.writableDatabase
            db.beginTransaction()
            inTransaction = true
            try {
                ensureBindingRow(db, binding)
                val stored = readCommand(db, command.commandId)
                if (stored != null) {
                    if (!stored.samePayload(command)) {
                        outcome = StoreApplyResult.Rejected(StoreRejection.CommandIdConflict)
                    } else {
                        val ack = ensurePendingAck(
                            db,
                            stored.commandId,
                            stored.deviceId,
                            stored.taxiId,
                            stored.revision,
                            nowEpochMillis,
                        )
                        outcome = StoreApplyResult.Applied(ack, duplicate = true)
                    }
                } else {
                    val currentRevision = when (command.kind) {
                        CommandKind.Pause -> scalarLong(
                            db,
                            "select pause_revision from device_control_state where id = 1",
                        )
                        CommandKind.Config -> scalarLong(
                            db,
                            "select config_revision from device_control_state where id = 1",
                        )
                    }
                    when {
                        command.revision < currentRevision -> {
                            outcome = StoreApplyResult.Older(currentRevision)
                        }
                        command.revision == currentRevision -> {
                            outcome = StoreApplyResult.Rejected(StoreRejection.RevisionConflict)
                        }
                        else -> {
                            applyState(db, command, nowEpochMillis)
                            insertCommand(db, command, nowEpochMillis)
                            val ack = ensurePendingAck(
                                db,
                                command.commandId,
                                command.deviceId,
                                command.taxiId,
                                command.revision,
                                nowEpochMillis,
                            )
                            outcome = StoreApplyResult.Applied(ack, duplicate = false)
                        }
                    }
                }
                db.setTransactionSuccessful()
            } finally {
                if (inTransaction) {
                    try {
                        db.endTransaction()
                    } catch (_: Exception) {
                        outcome = StoreApplyResult.Failure
                    }
                }
            }
        } catch (_: BindingMismatchException) {
            outcome = StoreApplyResult.Rejected(StoreRejection.BindingMismatch)
        } catch (_: Exception) {
            outcome = StoreApplyResult.Failure
        }
        return outcome
    }

    /**
     * Ein lokaler Standard darf eine bereits angewandte Fernpause nie
     * ueberschreiben. Nur ohne angewandte Pausenrevision wird geschrieben.
     */
    internal fun applyLocalDefaultPaused(
        binding: DeviceBinding,
        paused: Boolean,
        nowEpochMillis: Long,
    ): StoreLocalDefaultResult {
        var outcome = StoreLocalDefaultResult.Failure
        var inTransaction = false
        try {
            val db = helper.writableDatabase
            db.beginTransaction()
            inTransaction = true
            try {
                ensureBindingRow(db, binding)
                val revision = scalarLong(
                    db,
                    "select pause_revision from device_control_state where id = 1",
                )
                if (revision > 0L) {
                    outcome = StoreLocalDefaultResult.BlockedByRemote
                } else {
                    val values = ContentValues().apply {
                        put("pause_paused", if (paused) 1 else 0)
                        put("pause_revision", 0L)
                        putNull("pause_command_id")
                        put("pause_applied_at", nowEpochMillis)
                    }
                    if (db.update("device_control_state", values, "id = 1", null) != 1) {
                        throw IllegalStateException("missing control state")
                    }
                    outcome = StoreLocalDefaultResult.Applied
                }
                db.setTransactionSuccessful()
            } finally {
                if (inTransaction) {
                    try {
                        db.endTransaction()
                    } catch (_: Exception) {
                        outcome = StoreLocalDefaultResult.Failure
                    }
                }
            }
        } catch (_: BindingMismatchException) {
            outcome = StoreLocalDefaultResult.Failure
        } catch (_: Exception) {
            outcome = StoreLocalDefaultResult.Failure
        }
        return outcome
    }

    fun readState(): StoredControlState {
        val db = helper.readableDatabase
        return db.rawQuery(SELECT_STATE_SQL, null).use { cursor ->
            if (!cursor.moveToFirst()) {
                defaultState()
            } else {
                val pause = StoredPauseState(
                    paused = cursor.getInt(0) != 0,
                    revision = cursor.getLong(1),
                    commandId = if (cursor.isNull(2)) null else cursor.getString(2),
                    appliedAtEpochMillis = cursor.getLong(3),
                )
                val configRevision = cursor.getLong(4)
                val config = if (configRevision > 0L) {
                    StoredConfigState(
                        revision = configRevision,
                        values = ControlConfigValues(
                            gpsMode = if (cursor.isNull(5)) "" else cursor.getString(5),
                            pauseMaxDurationS = if (cursor.isNull(6)) null else cursor.getLong(6),
                            pauseEndOnVehicleOff = if (cursor.isNull(7)) {
                                null
                            } else {
                                cursor.getInt(7) != 0
                            },
                            displayRunOnS = if (cursor.isNull(8)) null else cursor.getLong(8),
                        ),
                        commandId = if (cursor.isNull(9)) null else cursor.getString(9),
                        appliedAtEpochMillis = if (cursor.isNull(10)) 0L else cursor.getLong(10),
                    )
                } else {
                    null
                }
                StoredControlState(pause, config)
            }
        }
    }

    fun pendingAcknowledgements(): List<PendingAcknowledgement> {
        val result = mutableListOf<PendingAcknowledgement>()
        helper.readableDatabase.rawQuery(
            "select command_id, revision from device_control_pending_ack " +
                "order by created_at, rowid",
            null,
        ).use { cursor ->
            while (cursor.moveToNext()) {
                result += PendingAcknowledgement(cursor.getString(0), cursor.getLong(1))
            }
        }
        return result
    }

    internal fun markAcknowledged(commandId: String): Boolean =
        helper.writableDatabase.delete(
            "device_control_pending_ack",
            "command_id = ?",
            arrayOf(commandId),
        ) > 0

    override fun close() {
        helper.close()
    }

    private fun ensureBindingRow(db: SQLiteDatabase, binding: DeviceBinding) {
        var bindingFound = false
        db.rawQuery(
            "select device_id, taxi_id from device_control_binding where id = 1",
            null,
        ).use { cursor ->
            if (cursor.moveToFirst()) {
                bindingFound = true
                if (cursor.getString(0) != binding.deviceId ||
                    cursor.getString(1) != binding.taxiId
                ) {
                    throw BindingMismatchException()
                }
            }
        }
        if (!bindingFound) {
            val values = ContentValues().apply {
                put("id", 1)
                put("device_id", binding.deviceId)
                put("taxi_id", binding.taxiId)
            }
            db.insertOrThrow("device_control_binding", null, values)
        }
        val stateExists = db.rawQuery(
            "select 1 from device_control_state where id = 1",
            null,
        ).use { it.moveToFirst() }
        if (!stateExists) {
            db.insertOrThrow("device_control_state", null, defaultStateValues())
        }
    }

    private fun readCommand(db: SQLiteDatabase, commandId: String): StoredCommand? =
        db.rawQuery(SELECT_COMMAND_SQL, arrayOf(commandId)).use { cursor ->
            if (!cursor.moveToFirst()) {
                null
            } else {
                val kind = CommandKind.values().firstOrNull { it.wire == cursor.getString(2) }
                    ?: throw IllegalStateException("unknown stored command kind")
                val config = if (cursor.isNull(5)) {
                    null
                } else {
                    ControlConfigValues(
                        gpsMode = cursor.getString(5) ?: "",
                        pauseMaxDurationS = if (cursor.isNull(6)) null else cursor.getLong(6),
                        pauseEndOnVehicleOff = if (cursor.isNull(7)) {
                            null
                        } else {
                            cursor.getInt(7) != 0
                        },
                        displayRunOnS = if (cursor.isNull(8)) null else cursor.getLong(8),
                    )
                }
                StoredCommand(
                    commandId = cursor.getString(0),
                    deviceId = cursor.getString(1),
                    taxiId = cursor.getString(3),
                    kind = kind,
                    revision = cursor.getLong(4),
                    desiredPaused = if (cursor.isNull(9)) null else cursor.getInt(9) != 0,
                    config = config,
                )
            }
        }

    private fun ensurePendingAck(
        db: SQLiteDatabase,
        commandId: String,
        deviceId: String,
        taxiId: String,
        revision: Long,
        nowEpochMillis: Long,
    ): PendingAcknowledgement {
        db.rawQuery(
            "select device_id, taxi_id, revision from device_control_pending_ack " +
                "where command_id = ?",
            arrayOf(commandId),
        ).use { cursor ->
            if (cursor.moveToFirst()) {
                if (cursor.getString(0) != deviceId ||
                    cursor.getString(1) != taxiId ||
                    cursor.getLong(2) != revision
                ) {
                    throw IllegalStateException("inconsistent pending acknowledgement")
                }
                return PendingAcknowledgement(commandId, revision)
            }
        }
        val values = ContentValues().apply {
            put("command_id", commandId)
            put("device_id", deviceId)
            put("taxi_id", taxiId)
            put("revision", revision)
            put("created_at", nowEpochMillis)
        }
        db.insertOrThrow("device_control_pending_ack", null, values)
        return PendingAcknowledgement(commandId, revision)
    }

    private fun applyState(
        db: SQLiteDatabase,
        command: ValidatedCommand,
        nowEpochMillis: Long,
    ) {
        val values = ContentValues()
        when (command.kind) {
            CommandKind.Pause -> {
                values.put("pause_paused", if (command.desiredPaused == true) 1 else 0)
                values.put("pause_revision", command.revision)
                values.put("pause_command_id", command.commandId)
                values.put("pause_applied_at", nowEpochMillis)
            }
            CommandKind.Config -> {
                val config = command.config
                    ?: throw IllegalStateException("config command without config")
                values.put("config_revision", command.revision)
                values.put("config_gps_mode", config.gpsMode)
                putNullableLong(values, "config_pause_max_duration_s", config.pauseMaxDurationS)
                putNullableBoolean(
                    values,
                    "config_pause_end_on_vehicle_off",
                    config.pauseEndOnVehicleOff,
                )
                putNullableLong(values, "config_display_run_on_s", config.displayRunOnS)
                values.put("config_command_id", command.commandId)
                values.put("config_applied_at", nowEpochMillis)
            }
        }
        if (db.update("device_control_state", values, "id = 1", null) != 1) {
            throw IllegalStateException("missing control state")
        }
    }

    private fun insertCommand(
        db: SQLiteDatabase,
        command: ValidatedCommand,
        nowEpochMillis: Long,
    ) {
        val values = ContentValues().apply {
            put("command_id", command.commandId)
            put("device_id", command.deviceId)
            put("taxi_id", command.taxiId)
            put("kind", command.kind.wire)
            put("revision", command.revision)
            put("applied_at", nowEpochMillis)
            when (command.kind) {
                CommandKind.Pause -> {
                    put("desired_paused", if (command.desiredPaused == true) 1 else 0)
                    putNull("config_gps_mode")
                    putNull("config_pause_max_duration_s")
                    putNull("config_pause_end_on_vehicle_off")
                    putNull("config_display_run_on_s")
                }
                CommandKind.Config -> {
                    val config = command.config
                        ?: throw IllegalStateException("config command without config")
                    putNull("desired_paused")
                    put("config_gps_mode", config.gpsMode)
                    putNullableLong(
                        this,
                        "config_pause_max_duration_s",
                        config.pauseMaxDurationS,
                    )
                    putNullableBoolean(
                        this,
                        "config_pause_end_on_vehicle_off",
                        config.pauseEndOnVehicleOff,
                    )
                    putNullableLong(
                        this,
                        "config_display_run_on_s",
                        config.displayRunOnS,
                    )
                }
            }
        }
        db.insertOrThrow("device_control_commands", null, values)
    }

    private fun scalarLong(db: SQLiteDatabase, sql: String): Long =
        db.rawQuery(sql, null).use { cursor ->
            if (cursor.moveToFirst()) cursor.getLong(0) else 0L
        }

    private fun defaultStateValues(): ContentValues = ContentValues().apply {
        put("id", 1)
        put("pause_paused", 0)
        put("pause_revision", 0L)
        putNull("pause_command_id")
        put("pause_applied_at", 0L)
        put("config_revision", 0L)
        putNull("config_gps_mode")
        putNull("config_pause_max_duration_s")
        putNull("config_pause_end_on_vehicle_off")
        putNull("config_display_run_on_s")
        putNull("config_command_id")
        putNull("config_applied_at")
    }

    private fun defaultState(): StoredControlState = StoredControlState(
        pause = StoredPauseState(
            paused = false,
            revision = 0L,
            commandId = null,
            appliedAtEpochMillis = 0L,
        ),
        config = null,
    )

    private class BindingMismatchException : Exception()

    private data class StoredCommand(
        val commandId: String,
        val deviceId: String,
        val taxiId: String,
        val kind: CommandKind,
        val revision: Long,
        val desiredPaused: Boolean?,
        val config: ControlConfigValues?,
    ) {
        fun samePayload(command: ValidatedCommand): Boolean {
            if (command.deviceId != deviceId ||
                command.taxiId != taxiId ||
                command.kind != kind ||
                command.revision != revision
            ) {
                return false
            }
            return when (kind) {
                CommandKind.Pause -> desiredPaused == command.desiredPaused
                CommandKind.Config -> config == command.config
            }
        }
    }

    private companion object {
        const val SELECT_STATE_SQL =
            "select pause_paused, pause_revision, pause_command_id, " +
                "pause_applied_at, config_revision, config_gps_mode, " +
                "config_pause_max_duration_s, config_pause_end_on_vehicle_off, " +
                "config_display_run_on_s, config_command_id, config_applied_at " +
                "from device_control_state where id = 1"

        const val SELECT_COMMAND_SQL =
            "select command_id, device_id, kind, taxi_id, revision, " +
                "config_gps_mode, config_pause_max_duration_s, " +
                "config_pause_end_on_vehicle_off, config_display_run_on_s, " +
                "desired_paused from device_control_commands where command_id = ?"

        fun putNullableLong(values: ContentValues, key: String, value: Long?) {
            if (value == null) values.putNull(key) else values.put(key, value)
        }

        fun putNullableBoolean(values: ContentValues, key: String, value: Boolean?) {
            if (value == null) values.putNull(key) else values.put(key, if (value) 1 else 0)
        }
    }
}
