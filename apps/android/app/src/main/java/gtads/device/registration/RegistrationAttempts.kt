package gtads.device.registration

import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean

/** Erzeugt die Anfragebytes; der Client-Request-Wert kommt aus dem einen Vorgang. */
internal fun interface RegistrationRequestFactory {
    fun create(
        registrationCode: String,
        publicKey: ByteArray,
        clientRequestId: String,
    ): ByteArray
}

/**
 * Genau ein laufender Registrierungsvorgang je Konfigurationsgeneration.
 * Ein zweiter Start derselben Generation wartet auf dieses Ergebnis und
 * erzeugt weder einen zweiten Schluessel noch eine zweite Request-ID.
 */
internal class RegistrationAttempt(
    val configuration: ServerConfiguration,
    val clientRequestId: String,
) {
    private val done = CountDownLatch(1)
    private val completed = AtomicBoolean(false)

    @Volatile
    private var completedState: RegistrationState? = null

    @Volatile
    private var completedOutcome: RegistrationOutcome? = null

    val state: RegistrationState? get() = completedState
    val outcome: RegistrationOutcome? get() = completedOutcome
    val isCompleted: Boolean get() = done.count == 0L

    fun complete(state: RegistrationState, outcome: RegistrationOutcome) {
        if (!completed.compareAndSet(false, true)) return
        completedState = state
        completedOutcome = outcome
        done.countDown()
    }

    fun await() {
        done.await()
    }
}

/** Prozessweiter Bestand laufender Vorgaenge, getrennt nach Generation. */
internal class RegistrationAttemptRegistry {
    private val lock = Any()
    private var current: RegistrationAttempt? = null

    fun current(): RegistrationAttempt? = synchronized(lock) { current }

    fun begin(configuration: ServerConfiguration): RegistrationAttempt = synchronized(lock) {
        val existing = current
        if (existing != null && !existing.isCompleted && existing.configuration == configuration) {
            existing
        } else {
            RegistrationAttempt(configuration, UUID.randomUUID().toString()).also { current = it }
        }
    }

    fun end(attempt: RegistrationAttempt) {
        synchronized(lock) {
            if (current === attempt) current = null
        }
    }

    companion object {
        val shared = RegistrationAttemptRegistry()
    }
}
