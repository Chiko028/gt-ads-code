package gtads.device.telemetry

import android.database.sqlite.SQLiteDatabase
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EventAppendStoreTest {

    @get:Rule
    val temporaryFolder = TemporaryFolder()

    private val openDatabases = mutableListOf<SQLiteDatabase>()

    @After
    fun closeDatabases() {
        openDatabases.forEach { if (it.isOpen) it.close() }
        openDatabases.clear()
    }

    private fun newDatabaseFile(): File = File(temporaryFolder.root, "telemetry-events.db")

    private fun open(file: File): SQLiteDatabase =
        SQLiteDatabase.openOrCreateDatabase(file, null).also { openDatabases += it }

    private fun createSchema(database: SQLiteDatabase) {
        database.execSQL(
            "create table telemetry_events (" +
                "seq integer primary key autoincrement, " +
                "event_id text not null unique, " +
                "device_id text not null, " +
                "payload_bytes blob not null)",
        )
    }

    private fun count(database: SQLiteDatabase): Long =
        database.rawQuery("select count(*) from telemetry_events", null).use { cursor ->
            cursor.moveToFirst()
            cursor.getLong(0)
        }

    private fun selectDeviceAndBytes(
        database: SQLiteDatabase,
        eventId: String,
    ): Pair<String, ByteArray>? =
        database.rawQuery(
            "select device_id, payload_bytes from telemetry_events where event_id = ?",
            arrayOf(eventId),
        ).use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) to cursor.getBlob(1) else null
        }

    @Test
    fun callerTransactionCommitsTwoEventsAndReopenedDatabaseKeepsBindingBytesAndOrder() {
        val file = newDatabaseFile()
        val writer = open(file)
        createSchema(writer)
        val store = EventAppendStore(writer)
        val firstBytes = byteArrayOf(1, 2, 3)
        val secondBytes = byteArrayOf(4, 5, 6)

        writer.beginTransaction()
        try {
            assertEquals(EventAppendStore.AppendResult.inserted, store.append("event-2", "device-a", firstBytes))
            assertEquals(EventAppendStore.AppendResult.inserted, store.append("event-1", "device-a", secondBytes))
            assertTrue(writer.inTransaction())
            writer.setTransactionSuccessful()
        } finally {
            writer.endTransaction()
        }
        firstBytes[0] = 99
        writer.close()

        val reopened = open(file)
        val rows = mutableListOf<Triple<String, String, ByteArray>>()
        reopened.rawQuery(
            "select event_id, device_id, payload_bytes from telemetry_events order by seq",
            null,
        ).use { cursor ->
            while (cursor.moveToNext()) {
                rows += Triple(cursor.getString(0), cursor.getString(1), cursor.getBlob(2))
            }
        }

        assertEquals(listOf("event-2", "event-1"), rows.map { it.first })
        assertEquals(listOf("device-a", "device-a"), rows.map { it.second })
        assertArrayEquals(byteArrayOf(1, 2, 3), rows[0].third)
        assertArrayEquals(byteArrayOf(4, 5, 6), rows[1].third)
    }

    @Test
    fun capacityOneDistinguishesAlreadyPresentConflictAndFullWithoutChangingStoredRow() {
        val database = open(newDatabaseFile())
        createSchema(database)
        val store = EventAppendStore(database, capacity = 1)

        database.beginTransaction()
        try {
            assertEquals(
                EventAppendStore.AppendResult.inserted,
                store.append("event-1", "device-a", byteArrayOf(7, 8)),
            )
            assertTrue(database.inTransaction())
            assertEquals(
                EventAppendStore.AppendResult.already_present,
                store.append("event-1", "device-a", byteArrayOf(7, 8)),
            )
            assertTrue(database.inTransaction())
            assertEquals(
                EventAppendStore.AppendResult.conflict,
                store.append("event-1", "device-b", byteArrayOf(7, 8)),
            )
            assertTrue(database.inTransaction())
            assertEquals(
                EventAppendStore.AppendResult.conflict,
                store.append("event-1", "device-a", byteArrayOf(7, 9)),
            )
            assertTrue(database.inTransaction())
            assertEquals(
                EventAppendStore.AppendResult.full,
                store.append("event-2", "device-a", byteArrayOf(7, 8)),
            )
            assertTrue(database.inTransaction())
            database.setTransactionSuccessful()
        } finally {
            database.endTransaction()
        }

        assertEquals(1L, count(database))
        val stored = selectDeviceAndBytes(database, "event-1")
        assertTrue(stored != null)
        assertEquals("device-a", stored!!.first)
        assertArrayEquals(byteArrayOf(7, 8), stored.second)
    }

    @Test
    fun appendRejectsMissingTransactionAndEmptyInputAndRolledBackTransactionLeavesNoRow() {
        val database = open(newDatabaseFile())
        createSchema(database)
        val store = EventAppendStore(database)

        assertThrows(IllegalStateException::class.java) {
            store.append("event-1", "device-a", byteArrayOf(1))
        }
        assertThrows(IllegalArgumentException::class.java) {
            store.append("", "device-a", byteArrayOf(1))
        }
        assertThrows(IllegalArgumentException::class.java) {
            store.append("event-1", "device-a", ByteArray(0))
        }
        assertEquals(0L, count(database))
        assertThrows(IllegalArgumentException::class.java) { EventAppendStore(database, 0) }
        assertThrows(IllegalArgumentException::class.java) { EventAppendStore(database, -1) }

        database.beginTransaction()
        try {
            assertEquals(
                EventAppendStore.AppendResult.inserted,
                store.append("event-1", "device-a", byteArrayOf(1)),
            )
            assertTrue(database.inTransaction())
        } finally {
            database.endTransaction()
        }
        assertEquals(0L, count(database))

        database.beginTransaction()
        try {
            assertEquals(
                EventAppendStore.AppendResult.inserted,
                store.append("event-2", "device-a", byteArrayOf(2)),
            )
            database.setTransactionSuccessful()
        } finally {
            database.endTransaction()
        }
        assertEquals(1L, count(database))
        assertEquals("device-a", selectDeviceAndBytes(database, "event-2")?.first)
    }
}

