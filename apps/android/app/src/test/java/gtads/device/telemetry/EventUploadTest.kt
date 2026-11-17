package gtads.device.telemetry

import android.database.sqlite.SQLiteDatabase
import androidx.work.ListenableWorker
import androidx.work.WorkManager
import androidx.work.testing.TestListenableWorkerBuilder
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** CX-094: Hintergrundupload mit echter Pufferdatenbank, Transport-Double und WorkManager-Testbaustein. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EventUploadTest {
    private val context = RuntimeEnvironment.getApplication()
    private val dbName = "cx094-${System.nanoTime()}.db"
    private val device = "SYN-device-094"
    private lateinit var db: SQLiteDatabase
    private var now = 1_800_000_000_000L

    @Before
    fun setUp() {
        WorkManager.resetForTest()
        db = TelemetryEventDatabase(context, dbName).writableDatabase
    }

    @After
    fun tearDown() {
        EventUploadWorker.factory = null
        WorkManager.resetForTest()
        db.close()
        context.deleteDatabase(dbName)
    }

    private fun store(vararg ids: String) {
        db.beginTransaction()
        try {
            val store = EventAppendStore(db)
            ids.forEach { store.append(it, device, """{"event_id":"$it"}""".toByteArray()) }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    private fun ids(): List<String> =
        db.rawQuery("select event_id from telemetry_events order by seq", null).use { c ->
            val list = ArrayList<String>()
            while (c.moveToNext()) list += c.getString(0)
            list
        }

    private fun coordinator(gate: UploadGate, send: (List<OutgoingEvent>) -> EventTransportResult) =
        EventUploadCoordinator(db, device, send, gate, wallClockMs = { now })

    @Test
    fun confirmedBatchIdsAreRemovedAtomicallyWhileNewAndUnconfirmedEventsRemain() {
        store("e1", "e2", "e3")
        var sent: List<String> = emptyList()
        val outcome = coordinator(InMemoryUploadGate()) { batch ->
            sent = batch.map { it.eventId }
            // Waehrend des Requests ist keine Transaktion offen; neue Ereignisse koennen gespeichert werden.
            assertTrue(!db.inTransaction())
            store("e4")
            // Bestaetigt werden e1 und e3 sowie eine nicht gesendete ID.
            EventTransportResult.Accepted(setOf("e1", "e3", "e4"))
        }.runOnce()

        assertEquals(listOf("e1", "e2", "e3"), sent)
        assertEquals(UploadOutcome.Uploaded(removed = 2, remaining = true), outcome)
        assertEquals(listOf("e2", "e4"), ids())
    }

    @Test
    fun lostResponseResendsSameIdsWithNewInstanceUntilValidConfirmation() {
        store("a", "b")
        val gate = InMemoryUploadGate()
        val batches = mutableListOf<List<String>>()
        // Server nimmt an, Antwort geht verloren.
        assertEquals(UploadOutcome.Retry, coordinator(gate) { b -> batches += b.map { it.eventId }; EventTransportResult.Retryable(null) }.runOnce())
        assertEquals(listOf("a", "b"), ids())

        // Neu erzeugte Koordinatorinstanz (z. B. nach Prozessende).
        val outcome = coordinator(gate) { b -> batches += b.map { it.eventId }; EventTransportResult.Accepted(setOf("a", "b")) }.runOnce()
        assertEquals(listOf(listOf("a", "b"), listOf("a", "b")), batches)
        assertEquals(UploadOutcome.Uploaded(removed = 2, remaining = false), outcome)
        assertEquals(emptyList<String>(), ids())
    }

    @Test
    fun repeatedSchedulingKeepsOneUploadAndTransientFailuresRetryWithBoundedBackoff() {
        store("w1")
        repeat(3) { EventUploadScheduler.enqueue(context) }
        assertEquals(1, WorkManager.getInstance(context).getWorkInfosForUniqueWork(EventUploadScheduler.UNIQUE_UPLOAD).get().size)

        val gate = InMemoryUploadGate()
        var calls = 0
        EventUploadWorker.factory = { coordinator(gate) { calls++; EventTransportResult.Retryable(120L) } }
        val first = TestListenableWorkerBuilder(context, EventUploadWorker::class.java).build().doWork()
        assertTrue(first is ListenableWorker.Result.Retry)
        assertEquals(listOf("w1"), ids())

        // Retry-After-Untergrenze: eine fruehere Ausfuehrung sendet nicht (keine Schleife).
        now += 119_000L
        val early = TestListenableWorkerBuilder(context, EventUploadWorker::class.java).build().doWork()
        assertTrue(early is ListenableWorker.Result.Retry)
        assertEquals(1, calls)
        now += 1_000L
        TestListenableWorkerBuilder(context, EventUploadWorker::class.java).build().doWork()
        assertEquals(2, calls)
        assertEquals(30L, EventUploadScheduler.BACKOFF_SECONDS)
    }

    @Test
    fun authFailureOrPermanentRejectionKeepsDataStopsRetryAndResumesAfterRegistration() {
        store("x1", "x2")
        val gate = InMemoryUploadGate()
        var calls = 0
        for (failure in listOf(EventTransportResult.AuthenticationRequired, EventTransportResult.Rejected(400))) {
            gate.resume()
            val outcome = coordinator(gate) { calls++; failure }.runOnce()
            assertTrue(outcome is UploadOutcome.Stopped)
            assertEquals(listOf("x1", "x2"), ids())
            // Keine automatische unmittelbare Wiederholung.
            val before = calls
            EventUploadWorker.factory = { coordinator(gate) { calls++; EventTransportResult.Accepted(setOf("x1", "x2")) } }
            val worker = TestListenableWorkerBuilder(context, EventUploadWorker::class.java).build().doWork()
            assertTrue(worker is ListenableWorker.Result.Success)
            assertEquals(before, calls)
            assertEquals(listOf("x1", "x2"), ids())
        }

        // Erneute gueltige Registrierung loest die Sperre; derselbe Bestand wird gesendet.
        gate.resume()
        val sent = mutableListOf<String>()
        val outcome = coordinator(gate) { b -> sent += b.map { it.eventId }; EventTransportResult.Accepted(setOf("x1", "x2")) }.runOnce()
        assertEquals(listOf("x1", "x2"), sent)
        assertEquals(UploadOutcome.Uploaded(2, false), outcome)
    }
}
