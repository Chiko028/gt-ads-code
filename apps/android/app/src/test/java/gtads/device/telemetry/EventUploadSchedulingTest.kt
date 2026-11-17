package gtads.device.telemetry

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.work.BackoffPolicy
import androidx.work.NetworkType
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkRequest
import androidx.work.testing.WorkManagerTestInitHelper
import gtads.device.registration.REGISTRATION_FILE_NAME
import gtads.device.registration.RegistrationRepository
import gtads.device.testsupport.initializeTestWorkManager
import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * REV-198: der tatsaechlich bei WorkManager geplante Uploadauftrag (Netzwerkbedingung, exponentieller
 * Backoff mit 30 s Start und WorkManager-Obergrenze 5 h), Retry bei Initialisierungsfehlern,
 * technischer Status bei Sperre und Wiederaufnahme ueber die echte Registrierungsanbindung.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EventUploadSchedulingTest {
    private val context: Context = RuntimeEnvironment.getApplication()
    private val dbName = "rev198-${System.nanoTime()}.db"
    private lateinit var db: SQLiteDatabase
    private var runs = 0

    @Before
    fun setUp() {
        initializeTestWorkManager(context)
        db = TelemetryEventDatabase(context, dbName).writableDatabase
        context.getSharedPreferences("gtads-technischer-status", Context.MODE_PRIVATE).edit().clear().commit()
        SharedPreferencesUploadGate(context).resume()
    }

    @After
    fun tearDown() {
        EventUploadWorker.factory = null
        db.close()
        context.deleteDatabase(dbName)
        File(context.noBackupFilesDir, REGISTRATION_FILE_NAME).delete()
        SharedPreferencesUploadGate(context).resume()
    }

    private fun store(vararg ids: String) {
        db.beginTransaction()
        try {
            val store = EventAppendStore(db)
            ids.forEach { store.append(it, DEVICE, """{"event_id":"$it"}""".toByteArray()) }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    private fun work(): WorkInfo = WorkManager.getInstance(context).getWorkInfosForUniqueWork(EventUploadScheduler.UNIQUE_UPLOAD).get().last()

    @Test
    fun plannedRequestCarriesNetworkConstraintAndExponentialBackoffAndRunsOnlyWithNetwork() {
        EventUploadWorker.factory = { runs++; EventUploadCoordinator(db, DEVICE, { EventTransportResult.Retryable(null) }, InMemoryUploadGate()) }
        store("e1")
        EventUploadScheduler.enqueue(context)
        val info = work()
        // Konfiguration des eingeplanten Auftrags (gleiche Bauvorschrift wie enqueue).
        val spec = EventUploadScheduler.request().workSpec
        assertEquals(NetworkType.CONNECTED, spec.constraints.requiredNetworkType)
        assertEquals(BackoffPolicy.EXPONENTIAL, spec.backoffPolicy)
        assertEquals(EventUploadScheduler.BACKOFF_SECONDS * 1000L, spec.backoffDelayDuration)
        // Ohne Netzwerk keine Ausfuehrung.
        assertEquals(WorkInfo.State.ENQUEUED, info.state)
        assertEquals(0, runs)
        // Netzwerk vorhanden: genau eine Ausfuehrung; voruebergehender Fehler -> erneut eingeplant (Backoff).
        WorkManagerTestInitHelper.getTestDriver(context)!!.setAllConstraintsMet(info.id)
        assertEquals(1, runs)
        assertEquals(WorkInfo.State.ENQUEUED, work().state)
        assertEquals(1, work().runAttemptCount)
        // Exponentiell mit Obergrenze: auch nach vielen Versuchen hoechstens 5 h Verzoegerung (WorkManager).
        val late = spec.copy(runAttemptCount = 30)
        assertTrue(late.calculateNextRunTime() - late.lastEnqueueTime <= WorkRequest.MAX_BACKOFF_MILLIS)
        assertEquals(5 * 60 * 60 * 1000L, WorkRequest.MAX_BACKOFF_MILLIS)
    }

    @Test
    fun initializationFailureRetriesAndStopReportsTechnicalStatus() {
        val status = TechnicalStatusStore(context)
        EventUploadWorker.factory = { throw IllegalStateException("SYN-db-nicht-oeffnbar") }
        EventUploadScheduler.enqueue(context)
        WorkManagerTestInitHelper.getTestDriver(context)!!.setAllConstraintsMet(work().id)
        assertEquals("Initialisierungsfehler -> Retry statt Erfolg", WorkInfo.State.ENQUEUED, work().state)
        assertEquals("initialisierung_fehlgeschlagen", status.current(EventUploadWorker.STATUS_COMPONENT))

        // Anmeldung abgelehnt: Daten bleiben, Sperre mit festem Code als technischer Status.
        store("e1")
        EventUploadWorker.factory = {
            EventUploadCoordinator(db, DEVICE, { EventTransportResult.AuthenticationRequired }, SharedPreferencesUploadGate(context))
        }
        WorkManager.getInstance(context).cancelAllWork()
        EventUploadScheduler.enqueue(context)
        WorkManagerTestInitHelper.getTestDriver(context)!!.setAllConstraintsMet(work().id)
        assertEquals(WorkInfo.State.SUCCEEDED, work().state)
        assertEquals("gesperrt_authentifizierung", status.current(EventUploadWorker.STATUS_COMPONENT))
        assertEquals("authentifizierung", SharedPreferencesUploadGate(context).suspendedReason())
    }

    @Test
    fun registrationConfirmationResumesThePersistentGateAndResendsTheSameStoredIds() {
        store("e1", "e2")
        val gate = SharedPreferencesUploadGate(context)
        gate.suspend("authentifizierung")
        val sent = ArrayList<List<String>>()
        EventUploadWorker.factory = {
            EventUploadCoordinator(db, DEVICE, { batch -> sent += batch.map { it.eventId }; EventTransportResult.Accepted(batch.map { it.eventId }.toSet()) },
                SharedPreferencesUploadGate(context))
        }
        // Gesperrt: ein Lauf sendet nichts.
        EventUploadScheduler.enqueue(context)
        WorkManagerTestInitHelper.getTestDriver(context)!!.setAllConstraintsMet(work().id)
        assertTrue(sent.isEmpty())

        // Echte Registrierungsanbindung (SyncScheduler.onRegistrationConfirmed ruft genau diese auf).
        RegistrationRepository(File(context.noBackupFilesDir, REGISTRATION_FILE_NAME)).writeRegistered("00000000-0000-4000-8000-0000000000d1", "https://gtads.example.invalid")
        EventUploadScheduler.onRegistrationConfirmed(context)
        assertNull(SharedPreferencesUploadGate(context).suspendedReason())
        val resumed = work()
        WorkManagerTestInitHelper.getTestDriver(context)!!.setAllConstraintsMet(resumed.id)
        assertEquals(listOf(listOf("e1", "e2")), sent)
        assertEquals(0, db.rawQuery("select count(*) from telemetry_events", null).use { it.moveToFirst(); it.getInt(0) })
    }

    private companion object {
        const val DEVICE = "SYN-device-198"
    }
}
