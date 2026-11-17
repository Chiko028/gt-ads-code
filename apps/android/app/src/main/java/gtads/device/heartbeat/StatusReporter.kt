package gtads.device.heartbeat

import android.content.Context
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Exakt der implementierte U5-Heartbeat-Vertrag (POST /v1/device/heartbeat):
 * seq, device_time, app_version, os_version. Keine weiteren Felder, keine
 * Fahrzeugzustaende.
 */
data class HeartbeatRequest(
    val seq: Long,
    val deviceTime: Instant,
    val appVersion: String,
    val osVersion: String,
) {
    companion object {
        /** Muster aus API-VERTRAG.md Abschnitt 1: UTC mit Millisekunden und Z. */
        private val FORMAT: DateTimeFormatter =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)

        fun deviceTime(instant: Instant): String =
            FORMAT.format(instant.atOffset(ZoneOffset.UTC))
    }
}

/** Ergebnis eines Heartbeat-Versuchs ohne Rohantworten oder Zugangsnachweise. */
sealed interface HeartbeatResult {
    data object Accepted : HeartbeatResult
    data object Retryable : HeartbeatResult
    data object AuthenticationRequired : HeartbeatResult
    data class Rejected(val status: Int) : HeartbeatResult
    data object InvalidInput : HeartbeatResult
}

/** Ein einzelner Aufruf; die Produktion nutzt den vorhandenen Geraetetransport. */
fun interface HeartbeatTransport {
    fun send(request: HeartbeatRequest): HeartbeatResult
}

/** Zeitgeber des Reporters; produktiv Handler, im Test kontrolliert. */
interface ReporterScheduler {
    fun schedule(delayMillis: Long, action: () -> Unit): Cancellable

    fun interface Cancellable {
        fun cancel()
    }
}

/** Monotone Folge pro App-Installation; in der Produktion persistent. */
interface SequenceStore {
    fun next(): Long
}

/** Nicht persistente Folge fuer Tests. */
class InMemorySequenceStore : SequenceStore {
    private val value = AtomicLong(0L)

    override fun next(): Long = value.getAndIncrement()
}

/** Persistente Folge in den privaten App-Einstellungen. */
class SharedPreferencesSequenceStore(
    context: Context,
    name: String = PREFERENCES_NAME,
) : SequenceStore {
    private val preferences =
        context.applicationContext.getSharedPreferences(name, Context.MODE_PRIVATE)

    @Synchronized
    override fun next(): Long {
        val stored = preferences.getLong(KEY_SEQUENCE, -1L)
        val next = stored + 1L
        preferences.edit().putLong(KEY_SEQUENCE, next).commit()
        return next
    }

    companion object {
        const val PREFERENCES_NAME: String = "device-heartbeat"
        private const val KEY_SEQUENCE = "seq"
    }
}

/**
 * Sendet den U5-Heartbeat auf dem vorhandenen authentifizierten
 * Geraetetransport (CX-085 / R-904).
 *
 * - Standardintervall 30 Minuten, Uhr und Transport injizierbar.
 * - Hoechstens ein laufender Request.
 * - Begrenzter Retry mit wachsendem Backoff, danach regulaeres Intervall;
 *   keine enge Schleife.
 * - Heartbeat und Ereignisupload bleiben getrennt: der Reporter liest und
 *   sendet nie gepufferte Wiedergabeereignisse.
 * - Arbeitet ausschliesslich zwischen [start] und [stop]; kein
 *   Hintergrunddienst.
 *
 * Offline- oder Autorisierungsfehler veraendern keine Wiedergabefreigabe und
 * erzeugen keine Fahrzeugzustaende; der Reporter kennt beides nicht.
 */
class StatusReporter(
    private val transport: HeartbeatTransport,
    private val scheduler: ReporterScheduler,
    private val executor: Executor,
    private val appVersion: () -> String,
    private val osVersion: () -> String,
    private val clock: () -> Instant = Instant::now,
    private val sequence: SequenceStore = InMemorySequenceStore(),
    private val intervalMillis: Long = DEFAULT_INTERVAL_MILLIS,
    private val maxRetries: Int = DEFAULT_MAX_RETRIES,
    private val retryBaseMillis: Long = DEFAULT_RETRY_BASE_MILLIS,
) {
    private val inFlight = AtomicBoolean(false)
    private var started = false
    private var retryAttempt = 0
    private var pending: ReporterScheduler.Cancellable? = null

    /** Letztes Ergebnis; nur fuer Diagnose, ohne Rohdaten. */
    @Volatile
    var lastResult: HeartbeatResult? = null
        private set

    /** Startet die erste Zustellung und plant danach das Intervall. Idempotent. */
    @Synchronized
    fun start() {
        if (started) return
        started = true
        retryAttempt = 0
        dispatch()
    }

    /** Beendet die Zustellung und bricht den geplanten Timer ab. Idempotent. */
    @Synchronized
    fun stop() {
        started = false
        pending?.cancel()
        pending = null
    }

    private fun dispatch() {
        if (!started) return
        if (!inFlight.compareAndSet(false, true)) return
        executor.execute { attempt() }
    }

    private fun attempt() {
        val request = HeartbeatRequest(
            seq = sequence.next(),
            deviceTime = clock(),
            appVersion = appVersion(),
            osVersion = osVersion(),
        )
        val result = try {
            transport.send(request)
        } catch (_: Throwable) {
            HeartbeatResult.Retryable
        }
        inFlight.set(false)
        handle(result)
    }

    @Synchronized
    private fun handle(result: HeartbeatResult) {
        lastResult = result
        if (!started) return
        when (result) {
            HeartbeatResult.Accepted -> {
                retryAttempt = 0
                plan(intervalMillis)
            }
            HeartbeatResult.Retryable -> {
                if (retryAttempt < maxRetries) {
                    val delay = backoffMillis(retryAttempt)
                    retryAttempt += 1
                    plan(delay)
                } else {
                    retryAttempt = 0
                    plan(intervalMillis)
                }
            }
            HeartbeatResult.AuthenticationRequired,
            HeartbeatResult.InvalidInput,
            is HeartbeatResult.Rejected -> {
                retryAttempt = 0
                plan(intervalMillis)
            }
        }
    }

    private fun plan(delayMillis: Long) {
        pending?.cancel()
        pending = scheduler.schedule(delayMillis.coerceAtLeast(0L)) {
            synchronized(this) { pending = null }
            dispatch()
        }
    }

    private fun backoffMillis(attempt: Int): Long {
        val factor = 1L shl attempt.coerceAtMost(MAX_BACKOFF_SHIFT)
        val delay = retryBaseMillis * factor
        return delay.coerceAtMost(MAX_RETRY_MILLIS).coerceAtMost(intervalMillis)
    }

    companion object {
        /** 30 Minuten. */
        const val DEFAULT_INTERVAL_MILLIS: Long = 30L * 60L * 1_000L
        const val DEFAULT_MAX_RETRIES: Int = 3
        const val DEFAULT_RETRY_BASE_MILLIS: Long = 30_000L
        const val MAX_RETRY_MILLIS: Long = 15L * 60L * 1_000L
        private const val MAX_BACKOFF_SHIFT = 4
    }
}
