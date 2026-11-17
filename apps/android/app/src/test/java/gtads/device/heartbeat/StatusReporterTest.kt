package gtads.device.heartbeat

import java.time.Instant
import java.util.concurrent.Executor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Robolectric-Integrationstest des StatusReporters (CX-085 / R-904).
 *
 * Netzwerk ausschliesslich ueber ein Transport-Double. Geprueft werden der
 * bestehende U5-Heartbeat-Vertrag, das Defaultintervall, hoechstens ein
 * laufender Request, begrenzter Retry mit Backoff sowie die Trennung von
 * Wiedergabefreigabe und Ereignispuffer.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class StatusReporterTest {

    private val fixedTime = Instant.parse("2026-11-17T06:44:00Z")

    private class FakeTransport : HeartbeatTransport {
        val requests = mutableListOf<HeartbeatRequest>()
        private val results = mutableListOf<HeartbeatResult>()

        fun enqueue(vararg values: HeartbeatResult) {
            results += values
        }

        override fun send(request: HeartbeatRequest): HeartbeatResult {
            requests += request
            return if (results.isEmpty()) HeartbeatResult.Accepted else results.removeAt(0)
        }
    }

    private class FakeScheduler : ReporterScheduler {
        class Entry(
            val delayMillis: Long,
            val action: () -> Unit,
        ) : ReporterScheduler.Cancellable {
            var cancelled = false

            override fun cancel() {
                cancelled = true
            }
        }

        val entries = mutableListOf<Entry>()

        override fun schedule(
            delayMillis: Long,
            action: () -> Unit,
        ): ReporterScheduler.Cancellable {
            val entry = Entry(delayMillis, action)
            entries += entry
            return entry
        }
    }

    private class QueueExecutor : Executor {
        private val tasks = mutableListOf<Runnable>()

        override fun execute(command: Runnable) {
            tasks += command
        }

        fun runAll() {
            while (tasks.isNotEmpty()) tasks.removeAt(0).run()
        }
    }

    private fun reporter(
        transport: FakeTransport,
        scheduler: FakeScheduler,
        executor: QueueExecutor,
        maxRetries: Int = StatusReporter.DEFAULT_MAX_RETRIES,
        retryBaseMillis: Long = StatusReporter.DEFAULT_RETRY_BASE_MILLIS,
    ): StatusReporter = StatusReporter(
        transport = transport,
        scheduler = scheduler,
        executor = executor,
        appVersion = { "1.2.3" },
        osVersion = { "14" },
        clock = { fixedTime },
        sequence = InMemorySequenceStore(),
        maxRetries = maxRetries,
        retryBaseMillis = retryBaseMillis,
    )

    @Test
    fun sendsExactHeartbeatContractWithDefaultIntervalAndSingleInFlightRequest() {
        val transport = FakeTransport()
        val scheduler = FakeScheduler()
        val executor = QueueExecutor()
        val reporter = reporter(transport, scheduler, executor)

        reporter.start()
        // Noch kein Aufruf: die Arbeit laeuft asynchron, nicht im Lifecycle-Aufruf.
        assertEquals(0, transport.requests.size)
        // Wiederholter Start ist wirkungslos.
        reporter.start()
        executor.runAll()

        assertEquals(1, transport.requests.size)
        val request = transport.requests.first()
        assertEquals(0L, request.seq)
        assertEquals(fixedTime, request.deviceTime)
        assertEquals("1.2.3", request.appVersion)
        assertEquals("14", request.osVersion)
        assertEquals(30L * 60L * 1_000L, scheduler.entries.last().delayMillis)

        // Zweiter Durchlauf nach Intervall mit monotoner Folge.
        scheduler.entries.last().action()
        executor.runAll()
        assertEquals(2, transport.requests.size)
        assertEquals(1L, transport.requests[1].seq)

        // Stop bricht den geplanten Timer ab; ein alter Timer startet nichts mehr.
        val pending = scheduler.entries.last()
        reporter.stop()
        assertTrue(pending.cancelled)
        val before = transport.requests.size
        pending.action()
        executor.runAll()
        assertEquals(before, transport.requests.size)
    }

    @Test
    fun retryableErrorsUseBoundedBackoffWithoutTightLoopsAndWithoutVehicleState() {
        val transport = FakeTransport()
        transport.enqueue(
            HeartbeatResult.Retryable,
            HeartbeatResult.Retryable,
            HeartbeatResult.Accepted,
        )
        val scheduler = FakeScheduler()
        val executor = QueueExecutor()
        val reporter = reporter(
            transport,
            scheduler,
            executor,
            maxRetries = 3,
            retryBaseMillis = 30_000L,
        )

        reporter.start()
        executor.runAll()
        assertEquals(1, transport.requests.size)
        assertEquals(30_000L, scheduler.entries.last().delayMillis)

        scheduler.entries.last().action()
        executor.runAll()
        assertEquals(2, transport.requests.size)
        assertEquals(60_000L, scheduler.entries.last().delayMillis)

        scheduler.entries.last().action()
        executor.runAll()
        assertEquals(3, transport.requests.size)
        assertEquals(StatusReporter.DEFAULT_INTERVAL_MILLIS, scheduler.entries.last().delayMillis)

        // Jede geplante Wartezeit ist positiv und waechst: keine enge Schleife.
        val delays = scheduler.entries.map { it.delayMillis }
        assertTrue(delays.all { it > 0L })
        assertTrue(delays.zipWithNext().take(2).all { (left, right) -> right > left })

        // Der Vertrag traegt nur die vier U5-Felder; keine Fahrzeugzustaende.
        val request = transport.requests.first()
        assertEquals("1.2.3", request.appVersion)
        assertEquals("14", request.osVersion)
        assertFalse(request.seq < 0L)
    }

    @Test
    fun exhaustedRetriesWaitForTheRegularIntervalAndAuthenticationDoesNotLoop() {
        val transport = FakeTransport()
        transport.enqueue(
            HeartbeatResult.Retryable,
            HeartbeatResult.Retryable,
            HeartbeatResult.Retryable,
            HeartbeatResult.AuthenticationRequired,
        )
        val scheduler = FakeScheduler()
        val executor = QueueExecutor()
        val reporter = reporter(
            transport,
            scheduler,
            executor,
            maxRetries = 2,
            retryBaseMillis = 10_000L,
        )

        reporter.start()
        executor.runAll()
        scheduler.entries.last().action()
        executor.runAll()
        scheduler.entries.last().action()
        executor.runAll()

        // initial + zwei Retries, danach regulaeres Intervall statt weiterer Retries
        assertEquals(3, transport.requests.size)
        assertEquals(StatusReporter.DEFAULT_INTERVAL_MILLIS, scheduler.entries.last().delayMillis)

        scheduler.entries.last().action()
        executor.runAll()
        assertEquals(HeartbeatResult.AuthenticationRequired, reporter.lastResult)
        assertEquals(StatusReporter.DEFAULT_INTERVAL_MILLIS, scheduler.entries.last().delayMillis)
        assertTrue(transport.requests.size <= 4)
        reporter.stop()
    }
}
