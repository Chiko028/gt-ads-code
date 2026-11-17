package gtads.device.control

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** CX-087: Abruf und Quittierung mit Transport-Double und realer lokaler Persistenz. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CommandPollerTest {
    private val context = RuntimeEnvironment.getApplication()
    private val dbName = "cx087-${System.nanoTime()}.db"
    private val binding = DeviceBinding("00000000-0000-4000-8000-0000000000d1", "SYN-taxi")
    private val services = mutableListOf<DeviceControlService>()
    private var mono = 1_000L

    @After
    fun tearDown() {
        services.forEach { it.close() }
        context.deleteDatabase(dbName)
    }

    private fun service(): DeviceControlService =
        DeviceControlService(DeviceControlStore(context, dbName), binding).also { services += it }

    private class FakeTransport : CommandTransport {
        var commands: List<WireCommand> = emptyList()
        var fetchAnswer: (() -> CommandFetchResult)? = null
        var ackAnswer: (PendingAcknowledgement) -> AckResult = { AckResult.Confirmed }
        val acks = mutableListOf<PendingAcknowledgement>()
        var fetches = 0
        override fun fetch(): CommandFetchResult {
            fetches++
            fetchAnswer?.let { return it() }
            return CommandFetchResult.Commands(commands)
        }
        override fun acknowledge(ack: PendingAcknowledgement): AckResult {
            acks += ack
            return ackAnswer(ack)
        }
    }

    private fun poller(transport: CommandTransport, service: DeviceControlService, latch: RevocationLatch = InMemoryRevocationLatch()) =
        CommandPoller(transport, service, binding, latch, monotonicMs = { mono })

    private val pause1 = WireCommand("11111111-1111-4111-8111-111111111111", 1, true)
    private val resume2 = WireCommand("22222222-2222-4222-8222-222222222222", 2, false)

    @Test
    fun fullPollPausesPlayerViaAdapterAndAcknowledgesOnlyAfterLocalCommit() {
        val service = service()
        val playerStates = mutableListOf<Boolean>()
        service.stateAdapter.observe { playerStates += it.paused }
        val transport = FakeTransport().apply { commands = listOf(pause1) }
        transport.ackAnswer = { ack ->
            // Zum Zeitpunkt der Quittung ist die Wirkung bereits lokal committet.
            assertTrue(service().effectiveState().paused)
            assertEquals(pause1.commandId, ack.commandId)
            AckResult.Confirmed
        }
        val poller = poller(transport, service)

        assertEquals(PollOutcome.Completed(applied = 1, acknowledged = 1), poller.pollOnce())
        assertEquals(listOf(false, true), playerStates)
        assertEquals(listOf(PendingAcknowledgement(pause1.commandId, 1)), transport.acks)
        assertTrue(service.pendingAcknowledgements().isEmpty())

        // Erneuter Abruf desselben Auftrags: keine zweite Zustandsaenderung.
        transport.ackAnswer = { AckResult.Confirmed }
        val again = poller.pollOnce() as PollOutcome.Completed
        assertEquals(0, again.applied)
        // Der Adapter darf denselben Zustand erneut melden, aber es gibt keinen Wechsel.
        val transitions = playerStates.filterIndexed { i, v -> i == 0 || playerStates[i - 1] != v }
        assertEquals(listOf(false, true), transitions)
    }

    @Test
    fun lostAckResponseIsRetriedWithSameIdentityAfterRestartWithoutResettingNewerResume() {
        val first = service()
        val transport = FakeTransport().apply { commands = listOf(pause1) }
        transport.ackAnswer = { AckResult.Transient }
        val outcome = poller(transport, first).pollOnce()
        assertTrue(outcome is PollOutcome.RetryLater)
        assertTrue(first.effectiveState().paused)
        assertEquals(listOf(PendingAcknowledgement(pause1.commandId, 1)), first.pendingAcknowledgements())
        first.close()
        services.remove(first)

        // Prozessneustart: neue Instanzen auf derselben Datenbank; Server liefert inzwischen Fortsetzen rev 2.
        val restarted = service()
        val transport2 = FakeTransport().apply { commands = listOf(resume2) }
        val result = poller(transport2, restarted).pollOnce()
        assertEquals(PollOutcome.Completed(applied = 1, acknowledged = 2), result)
        assertEquals(PendingAcknowledgement(pause1.commandId, 1), transport2.acks.first())
        assertEquals(PendingAcknowledgement(resume2.commandId, 2), transport2.acks.last())
        assertFalse(restarted.effectiveState().paused)
        assertEquals(2L, restarted.effectiveState().pauseRevision)

        // Verspaetet erneut zugestellter alter Pausenbefehl setzt nichts zurueck.
        transport2.commands = listOf(pause1)
        poller(transport2, restarted).pollOnce()
        assertFalse(restarted.effectiveState().paused)
    }

    @Test
    fun parallelTriggersRetryAfterBackoffAndRevocationAreHandled() {
        val service = service()
        val transport = FakeTransport()
        lateinit var poller: CommandPoller
        var nested: PollOutcome? = null
        transport.fetchAnswer = {
            nested = poller.pollOnce()
            CommandFetchResult.RetryLater(afterMs = 120_000L)
        }
        poller = poller(transport, service)

        val first = poller.pollOnce()
        assertEquals(PollOutcome.Busy, nested)
        assertEquals(1, transport.fetches)
        assertEquals(PollOutcome.RetryLater(120_000L), first)

        // Vor Ablauf von Retry-After kein Abruf.
        mono += 119_999L
        assertEquals(PollOutcome.Deferred, poller.pollOnce())
        assertEquals(1, transport.fetches)

        // Temporaere Fehler: wachsender, begrenzter Backoff statt enger Schleife.
        transport.fetchAnswer = { CommandFetchResult.Transient }
        mono += 1L
        val waits = mutableListOf<Long>()
        repeat(3) {
            val r = poller.pollOnce() as PollOutcome.RetryLater
            waits += r.retryInMs
            mono += r.retryInMs
        }
        assertTrue(waits.zipWithNext().all { (a, b) -> b > a })
        assertTrue(waits.all { it >= CommandPoller.DEFAULT_BACKOFF_BASE_MS })

        // Expliziter Widerruf: dauerhaft keine weiteren Abrufe.
        transport.fetchAnswer = { CommandFetchResult.Revoked }
        val latchFetches = transport.fetches
        assertEquals(PollOutcome.Revoked, poller.pollOnce())
        mono += 10L * 60_000L
        assertEquals(PollOutcome.Revoked, poller.pollOnce())
        assertEquals(latchFetches + 1, transport.fetches)
    }
}
