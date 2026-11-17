package gtads.device.control

import android.content.Context
import java.util.concurrent.atomic.AtomicBoolean

/** Dauerhafte Sperre nach explizitem Widerruf (403 device_revoked). */
interface RevocationLatch {
    fun isRevoked(): Boolean
    fun markRevoked()
}

class InMemoryRevocationLatch : RevocationLatch {
    @Volatile
    private var revoked = false
    override fun isRevoked(): Boolean = revoked
    override fun markRevoked() {
        revoked = true
    }
}

class SharedPreferencesRevocationLatch(context: Context) : RevocationLatch {
    private val preferences = context.applicationContext.getSharedPreferences("device-commands", Context.MODE_PRIVATE)
    override fun isRevoked(): Boolean = preferences.getBoolean(KEY, false)
    override fun markRevoked() {
        preferences.edit().putBoolean(KEY, true).commit()
    }
    private companion object {
        const val KEY = "revoked"
    }
}

/** Ergebnis genau eines Abrufdurchlaufs. */
sealed interface PollOutcome {
    /** [applied] tatsaechlich angewandte Befehle, [acknowledged] bestaetigte Quittungen. */
    data class Completed(val applied: Int, val acknowledged: Int) : PollOutcome
    /** Ein anderer Durchlauf laeuft; kein zweiter Abruf. */
    data object Busy : PollOutcome
    /** Wartezeit (Retry-After/Backoff) noch nicht abgelaufen. */
    data object Deferred : PollOutcome
    /** Temporaerer Fehler; naechster Versuch nach [retryInMs]. */
    data class RetryLater(val retryInMs: Long) : PollOutcome
    /** Anmeldung erforderlich; vorhandene Auth-Erneuerung beim naechsten Durchlauf. */
    data object AuthenticationRequired : PollOutcome
    /** Explizit widerrufen: keine weiteren Abrufe. */
    data object Revoked : PollOutcome
}

/**
 * Abruf und Quittierung von R-905 (CX-087) ueber den lokalen Kern aus CX-086.
 *
 * - Ausstehende Quittungen kommen aus der lokalen Datenbank (Wiederanlauf)
 *   und werden mit derselben Identitaet wiederholt; geloescht wird erst nach
 *   vertragskonformer Serverbestaetigung.
 * - Befehle werden in Serverreihenfolge angewandt; quittiert wird nur, was
 *   lokal dauerhaft gespeichert wurde, nie pauschal ein ganzer Batch.
 * - Parallele Ausloeser erzeugen nur einen Durchlauf; 429/503 respektiert
 *   Retry-After, temporaere Fehler nutzen begrenzten exponentiellen Backoff.
 * - Ein expliziter Widerruf beendet weitere Abrufe dauerhaft.
 * - Pause/Fortsetzen erreicht den Player nur ueber den vorhandenen
 *   [ControlStateAdapter] des Dienstes.
 */
class CommandPoller(
    private val transport: CommandTransport,
    private val service: DeviceControlService,
    private val binding: DeviceBinding,
    private val revocation: RevocationLatch,
    private val monotonicMs: () -> Long,
    private val maxBatch: Int = DEFAULT_MAX_BATCH,
    private val backoffBaseMs: Long = DEFAULT_BACKOFF_BASE_MS,
    private val backoffMaxMs: Long = DEFAULT_BACKOFF_MAX_MS,
) {
    private val running = AtomicBoolean(false)
    @Volatile
    private var notBefore = Long.MIN_VALUE
    @Volatile
    private var failures = 0

    fun pollOnce(): PollOutcome {
        if (revocation.isRevoked()) return PollOutcome.Revoked
        if (!running.compareAndSet(false, true)) return PollOutcome.Busy
        try {
            if (monotonicMs() < notBefore) return PollOutcome.Deferred
            var acknowledged = 0
            // 1. Ausstehende Quittungen (auch nach Prozessneustart) zuerst wiederholen.
            when (val first = sendPending()) {
                is Step.Stop -> return first.outcome
                is Step.Continue -> acknowledged += first.count
            }
            // 2. Abruf.
            val commands = when (val fetched = transport.fetch()) {
                is CommandFetchResult.Commands -> fetched.items
                is CommandFetchResult.RetryLater -> return defer(fetched.afterMs)
                CommandFetchResult.Transient, CommandFetchResult.Invalid -> return defer(null)
                CommandFetchResult.AuthenticationRequired -> return PollOutcome.AuthenticationRequired
                CommandFetchResult.Revoked -> return revoke()
            }
            // 3. Anwenden in Serverreihenfolge, begrenzt.
            var applied = 0
            for (wire in commands.take(maxBatch)) {
                val result = service.apply(
                    DeviceControlCommand.SetPause(wire.commandId, binding.deviceId, binding.taxiId, wire.revision, wire.desiredPaused),
                )
                when (result) {
                    is DeviceControlApplyResult.Applied -> if (!result.duplicate) applied++
                    is DeviceControlApplyResult.IgnoredOlder, is DeviceControlApplyResult.Rejected -> Unit
                    // Speicherfehler: keine Quittung, Rest des Batches beim naechsten Durchlauf.
                    DeviceControlApplyResult.StorageFailure -> break
                }
            }
            // 4. Nur lokal dauerhaft gespeicherte Ergebnisse quittieren.
            when (val second = sendPending()) {
                is Step.Stop -> return second.outcome
                is Step.Continue -> acknowledged += second.count
            }
            failures = 0
            return PollOutcome.Completed(applied, acknowledged)
        } finally {
            running.set(false)
        }
    }

    private sealed interface Step {
        data class Continue(val count: Int) : Step
        data class Stop(val outcome: PollOutcome) : Step
    }

    private fun sendPending(): Step {
        var count = 0
        for (ack in service.pendingAcknowledgements()) {
            when (val result = transport.acknowledge(ack)) {
                AckResult.Confirmed -> {
                    service.acknowledgeDelivered(ack.commandId)
                    count++
                }
                // Ueberholt: der Server wird diese Identitaet nie mehr annehmen.
                AckResult.Superseded -> service.acknowledgeDelivered(ack.commandId)
                is AckResult.RetryLater -> return Step.Stop(defer(result.afterMs))
                AckResult.Transient -> return Step.Stop(defer(null))
                AckResult.AuthenticationRequired -> return Step.Stop(PollOutcome.AuthenticationRequired)
                AckResult.Revoked -> return Step.Stop(revoke())
            }
        }
        return Step.Continue(count)
    }

    private fun defer(retryAfterMs: Long?): PollOutcome {
        val exponent = failures.coerceAtMost(MAX_SHIFT)
        failures++
        val backoff = (backoffBaseMs shl exponent).coerceAtMost(backoffMaxMs)
        val wait = maxOf(backoff, retryAfterMs ?: 0L)
        notBefore = monotonicMs() + wait
        return PollOutcome.RetryLater(wait)
    }

    private fun revoke(): PollOutcome {
        revocation.markRevoked()
        return PollOutcome.Revoked
    }

    companion object {
        const val DEFAULT_MAX_BATCH = 20
        const val DEFAULT_BACKOFF_BASE_MS = 15_000L
        const val DEFAULT_BACKOFF_MAX_MS = 15L * 60_000L
        private const val MAX_SHIFT = 6
    }
}

/**
 * Lebenszyklusgebundener Abruf im aktiven App-Lifecycle: standardmaessig alle
 * 15 Sekunden, konfigurierbar, ohne ueberlappende Requests (Executor + Sperre
 * des Pollers). Keine exakten Hintergrundintervalle.
 */
class CommandPollingLoop(
    private val poller: CommandPoller,
    private val schedule: (delayMs: Long, action: () -> Unit) -> AutoCloseable,
    private val execute: (() -> Unit) -> Unit,
    private val intervalMs: Long = DEFAULT_INTERVAL_MS,
) {
    private var started = false
    private var task: AutoCloseable? = null

    @Synchronized
    fun start() {
        if (started) return
        started = true
        trigger()
    }

    @Synchronized
    fun stop() {
        started = false
        task?.close()
        task = null
    }

    /** Zusaetzlicher Ausloeser (z. B. Wiederverbindung); ueberlappt nie. */
    fun trigger() {
        execute {
            val outcome = poller.pollOnce()
            val next = when (outcome) {
                is PollOutcome.RetryLater -> maxOf(outcome.retryInMs, intervalMs)
                PollOutcome.Revoked -> null
                else -> intervalMs
            }
            synchronized(this) {
                task?.close()
                task = if (started && next != null) schedule(next) { trigger() } else null
            }
        }
    }

    companion object {
        const val DEFAULT_INTERVAL_MS = 15_000L
    }
}
