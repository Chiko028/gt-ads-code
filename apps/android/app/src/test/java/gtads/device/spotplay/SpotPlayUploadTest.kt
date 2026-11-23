package gtads.device.spotplay

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.TestListenableWorkerBuilder
import gtads.device.auth.DeviceAuthResult
import gtads.device.playback.SpotPlayRecord
import gtads.device.telemetry.BatchRoute
import gtads.device.telemetry.DeviceEventTransport
import gtads.device.telemetry.EventTransportResult
import gtads.device.telemetry.EventUploadCoordinator
import gtads.device.telemetry.InMemoryUploadGate
import gtads.device.telemetry.OutgoingEvent
import gtads.device.telemetry.SharedPreferencesUploadGate
import gtads.device.telemetry.UploadOutcome
import gtads.device.testsupport.initializeTestWorkManager
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import org.json.JSONObject
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

/** Aufzeichnende Verbindung ohne Netzwerk; gleiche Form wie im Ereignistransporttest. */
private class FakeSpotConnection(url: URL) : HttpURLConnection(url) {
    var responseBody = ByteArray(0)
    var status = 200
    val sent = ByteArrayOutputStream()
    val requestHeaders = HashMap<String, String>()
    var disconnectedFlag = false
    var fixedLength: Int? = null

    override fun connect() = Unit
    override fun disconnect() { disconnectedFlag = true }
    override fun usingProxy() = false
    override fun setFixedLengthStreamingMode(contentLength: Int) { fixedLength = contentLength }
    override fun setRequestProperty(key: String, value: String) { requestHeaders[key] = value }
    override fun getOutputStream(): OutputStream = sent
    override fun getResponseCode(): Int = status
    override fun getInputStream(): InputStream = ByteArrayInputStream(responseBody)
    override fun getErrorStream(): InputStream = ByteArrayInputStream(responseBody)
}

/**
 * CX-160: Puffer, Upload und Transport der Abspielnachweise.
 *
 * Der Puffer nutzt eine echte SQLite-Datenbank (Robolectric), der Transport
 * eine aufzeichnende Verbindung; es gibt keinen Netzaufruf. Geprueft werden
 * exaktes Serverschema, ended_at, Verwerfen ungueltiger Meldungen, Kapazitaet,
 * die Tabelle spot_plays und die Loeschung ausschliesslich bestaetigter IDs.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SpotPlayUploadTest {
    private val context: Context = RuntimeEnvironment.getApplication()
    private val dbName = "cx160-${System.nanoTime()}.db"
    private lateinit var db: SQLiteDatabase

    private val campaign = "11111111-1111-4111-8111-111111111111"
    private val media = "22222222-2222-4222-8222-222222222222"
    private val device = "33333333-3333-4333-8333-333333333333"

    @Before
    fun setUp() {
        initializeTestWorkManager(context)
        db = SpotPlayDatabase(context, dbName).writableDatabase
        SharedPreferencesUploadGate(context).resume()
        SharedPreferencesUploadGate(context, SpotPlayUploadScheduler.PREFERENCES_NAME).resume()
    }

    @After
    fun tearDown() {
        SpotPlayUploadWorker.factory = null
        db.close()
        context.deleteDatabase(dbName)
        context.getSharedPreferences("gtads-technischer-status", Context.MODE_PRIVATE).edit().clear().commit()
        SharedPreferencesUploadGate(context).resume()
        SharedPreferencesUploadGate(context, SpotPlayUploadScheduler.PREFERENCES_NAME).resume()
    }

    private fun record(
        campaignId: String = campaign,
        mediaId: String = media,
        startedAt: Instant = Instant.parse("2026-01-02T03:04:05.678Z"),
        playedMs: Long = 4_321L,
        completed: Boolean = true,
    ) = SpotPlayRecord(campaignId, mediaId, startedAt, playedMs, completed)

    private fun payloads(): List<JSONObject> =
        db.rawQuery("select payload_bytes from spot_plays order by seq", null).use { cursor ->
            val list = ArrayList<JSONObject>()
            while (cursor.moveToNext()) {
                list += JSONObject(String(cursor.getBlob(0), Charsets.UTF_8))
            }
            list
        }

    private fun storedIds(): List<String> =
        db.rawQuery("select event_id from spot_plays order by seq", null).use { cursor ->
            val list = ArrayList<String>()
            while (cursor.moveToNext()) list += cursor.getString(0)
            list
        }

    private fun count(): Int =
        db.rawQuery("select count(*) from spot_plays", null).use { it.moveToFirst(); it.getInt(0) }

    @Test
    fun nutzdatenEntsprechenExaktDemServerschemaUndEndedAtAusStartUndDauer() {
        val started = Instant.parse("2026-01-02T03:04:05.678Z")
        assertEquals(
            SpotPlayAppend.inserted,
            SpotPlayRecorder(db, device).record(record(startedAt = started, playedMs = 4_321L)),
        )

        val payload = payloads().single()
        assertEquals(
            setOf("play_id", "campaign_id", "media_id", "started_at", "ended_at", "played_ms", "completed"),
            payload.keys().asSequence().toSet(),
        )
        assertEquals(campaign, payload.getString("campaign_id"))
        assertEquals(media, payload.getString("media_id"))
        assertEquals(4_321, payload.getInt("played_ms"))
        assertTrue(payload.getBoolean("completed"))
        assertEquals("2026-01-02T03:04:05.678Z", payload.getString("started_at"))
        assertEquals(started.plusMillis(4_321L), Instant.parse(payload.getString("ended_at")))
        assertEquals("2026-01-02T03:04:09.999Z", payload.getString("ended_at"))
        // Die lokale event_id ist die play_id; nur so kann der Koordinator bestaetigte Zeilen loeschen.
        assertEquals(payload.getString("play_id"), storedIds().single())
        assertEquals(
            device,
            db.rawQuery("select device_id from spot_plays", null).use { it.moveToFirst(); it.getString(0) },
        )
    }

    @Test
    fun nichtUuidsUndNullDauernWerdenVerworfen() {
        val recorder = SpotPlayRecorder(db, device)
        assertEquals(SpotPlayAppend.invalid, recorder.record(record(campaignId = "keine-uuid")))
        assertEquals(SpotPlayAppend.invalid, recorder.record(record(mediaId = "video-1")))
        assertEquals(SpotPlayAppend.invalid, recorder.record(record(playedMs = 0L)))
        assertEquals(SpotPlayAppend.invalid, recorder.record(record(playedMs = -5L)))
        assertEquals(SpotPlayAppend.invalid, recorder.record(record(playedMs = 3_600_001L)))
        assertEquals("keine ungueltige Zeile", 0, count())
        assertEquals(0, payloads().size)
    }

    @Test
    fun kapazitaetVerwirftNeueNachweiseOhneAltbestandZuVerdraengen() {
        val recorder = SpotPlayRecorder(db, device, capacity = 2)
        assertEquals(SpotPlayAppend.inserted, recorder.record(record(playedMs = 1_000L)))
        assertEquals(SpotPlayAppend.inserted, recorder.record(record(playedMs = 2_000L)))
        val before = storedIds()
        assertEquals(SpotPlayAppend.full, recorder.record(record(playedMs = 3_000L)))
        assertEquals(2, count())
        assertEquals(before, storedIds())
        assertEquals(listOf(1_000, 2_000), payloads().map { it.getInt("played_ms") })
    }

    @Test
    fun koordinatorLoeschtAusSpotTabelleNurVomServerBestaetigteIds() {
        val recorder = SpotPlayRecorder(db, device)
        repeat(3) { recorder.record(record(playedMs = 1_000L + it)) }
        val ids = storedIds()
        var sent: List<String> = emptyList()
        val outcome = EventUploadCoordinator(
            database = db,
            deviceId = device,
            send = { batch ->
                sent = batch.map { it.eventId }
                EventTransportResult.Accepted(setOf(ids[0], ids[2]))
            },
            gate = InMemoryUploadGate(),
            table = EventUploadCoordinator.TABLE_SPOT_PLAYS,
        ).runOnce()

        assertEquals(ids, sent)
        assertEquals(UploadOutcome.Uploaded(removed = 2, remaining = true), outcome)
        assertEquals("nur die unbestätigte ID bleibt", listOf(ids[1]), storedIds())
    }

    @Test
    fun transportSendetPlaysAnSpotPlaysUndUebernimmtNurBestaetigteIds() {
        val first = "44444444-4444-4444-8444-444444444444"
        val second = "55555555-5555-4555-8555-555555555555"
        val plays = listOf(first, second).map { id ->
            OutgoingEvent(
                id,
                ("{\"play_id\":\"" + id + "\",\"campaign_id\":\"" + campaign + "\",\"media_id\":\"" + media +
                    "\",\"started_at\":\"2026-01-02T03:04:05.678Z\",\"ended_at\":\"2026-01-02T03:04:06.678Z\"," +
                    "\"played_ms\":1000,\"completed\":true}").toByteArray(Charsets.UTF_8),
            )
        }
        val fake = FakeSpotConnection(URL("https://unused.invalid"))
        fake.responseBody = ("{\"accepted\":1,\"inserted\":1,\"duplicate_play_ids\":[],\"accepted_play_ids\":[\"" + first + "\"]}")
            .toByteArray()
        var opened: URL? = null
        val transport = DeviceEventTransport(
            baseUrl = "https://gtads.example.invalid/basis",
            obtainToken = { DeviceAuthResult.Token("SYN-TOKEN") },
            route = BatchRoute.SPOT_PLAYS,
            openConnection = { url -> opened = url; fake },
            onMainThread = { false },
        )

        val result = transport.send(plays)

        assertEquals(EventTransportResult.Accepted(setOf(first)), result)
        assertEquals("https://gtads.example.invalid/basis/v1/device/spot-plays", opened.toString())
        assertEquals("Bearer SYN-TOKEN", fake.requestHeaders["Authorization"])
        val expected = "{\"plays\":[" + plays.joinToString(",") { String(it.payloadBytes(), Charsets.UTF_8) } + "]}"
        assertEquals(expected, String(fake.sent.toByteArray(), Charsets.UTF_8))
        val root = JSONObject(String(fake.sent.toByteArray(), Charsets.UTF_8))
        assertEquals(2, root.getJSONArray("plays").length())
        assertTrue(fake.disconnectedFlag)
    }

    @Test
    fun zeitplanIstPeriodischAlleFuenfzehnMinutenMitNetzbedingungUndLoestBeimAppStartDieSperre() {
        val spec = SpotPlayUploadScheduler.periodicRequest().workSpec
        assertEquals(15 * 60 * 1000L, spec.intervalDuration)
        assertEquals(NetworkType.CONNECTED, spec.constraints.requiredNetworkType)
        val oneTime = SpotPlayUploadScheduler.oneTimeRequest().workSpec
        assertEquals(NetworkType.CONNECTED, oneTime.constraints.requiredNetworkType)

        val gate = SharedPreferencesUploadGate(context, SpotPlayUploadScheduler.PREFERENCES_NAME)
        gate.suspend("authentifizierung")
        SpotPlayUploadScheduler.onAppStarted(context)

        assertNull("App-Start loest die Sperre", gate.suspendedReason())
        val periodic = WorkManager.getInstance(context)
            .getWorkInfosForUniqueWork(SpotPlayUploadScheduler.UNIQUE_PERIODIC).get()
        assertEquals(1, periodic.size)
        val once = WorkManager.getInstance(context)
            .getWorkInfosForUniqueWork(SpotPlayUploadScheduler.UNIQUE_ONE_TIME).get()
        assertEquals(1, once.size)
        assertEquals(WorkInfo.State.ENQUEUED, once.single().state)
    }

    @Test
    fun workerLoeschtNurBestaetigteNachweiseAusDemSpotPuffer() {
        val recorder = SpotPlayRecorder(db, device)
        repeat(2) { recorder.record(record(playedMs = 1_000L + it)) }
        val ids = storedIds()
        SpotPlayUploadWorker.factory = {
            EventUploadCoordinator(
                database = db,
                deviceId = device,
                send = { batch -> EventTransportResult.Accepted(setOf(batch.first().eventId)) },
                gate = InMemoryUploadGate(),
                table = EventUploadCoordinator.TABLE_SPOT_PLAYS,
            )
        }

        val result = TestListenableWorkerBuilder.from(context, SpotPlayUploadWorker::class.java).build().doWork()

        assertTrue(result is ListenableWorker.Result.Success)
        assertEquals(listOf(ids[1]), storedIds())
    }
}
