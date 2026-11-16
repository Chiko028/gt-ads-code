package gtads.device.registration

import gtads.device.identity.DeviceIdentity
import java.time.Instant
import java.util.Base64
import org.json.JSONObject

/** Geraetefakten exakt im bestehenden CX-070-Format. */
data class RegistrationDeviceInfo(
    val manufacturer: String,
    val model: String,
    val osVersion: String,
    val sdkInt: Int,
    val appVersion: String,
    val appFlavor: String,
)

/**
 * Ein serialisierter Registrierungsversuch je Prozess. Nur NotRegistered
 * sendet; laufende, registrierte und unklare Zustaende senden nichts.
 * Jeder Vorgang ist an normalisierte Serveradresse und persistente
 * Konfigurationsgeneration gebunden; ein Wechsel verwirft sein Ergebnis.
 */
class RegistrationCoordinator internal constructor(
    private val store: RegistrationStore,
    private val identity: DeviceIdentity,
    private val baseUrl: String,
    private val appEnv: String,
    private val deviceInfo: RegistrationDeviceInfo,
    private val transport: (ByteArray) -> TransportResult,
    private val configurationStore: ServerConfigurationStore,
    private val attempts: RegistrationAttemptRegistry,
    private val requestFactory: RegistrationRequestFactory,
) {
    constructor(
        repository: RegistrationRepository,
        identity: DeviceIdentity,
        baseUrl: String,
        appEnv: String,
        deviceInfo: RegistrationDeviceInfo,
        transport: (ByteArray) -> TransportResult =
            { DeviceRegistrationTransport(baseUrl).send(it) },
    ) : this(
        repository,
        identity,
        baseUrl,
        appEnv,
        deviceInfo,
        transport,
        repository.configurationStore(),
        RegistrationAttemptRegistry.shared,
        JsonRegistrationRequestFactory(appEnv, deviceInfo),
    )

    @Volatile
    private var inFlight = false

    @Volatile
    private var lastOutcome: RegistrationOutcome? = null

    /** Anzeigekategorie des letzten Versuchs; nie Rohtext oder Serverinhalt. */
    fun outcome(): RegistrationOutcome? = lastOutcome

    fun state(): RegistrationState =
        if (inFlight) RegistrationState.Registering else store.read()

    fun register(registrationCode: String): RegistrationState {
        val normalized = normalizeServerBaseUrl(baseUrl)
            ?: return conclude(
                RegistrationState.Failed(RegistrationFailure.INVALID_BASE_URL),
                RegistrationOutcome.INVALID_INPUT,
            )
        val configuration = synchronized(RegistrationSerialization.lock) {
            configurationStore.activate(normalized)
        } ?: return conclude(
            RegistrationState.Failed(RegistrationFailure.STORAGE_UNAVAILABLE),
            RegistrationOutcome.UNCERTAIN,
        )

        val running = attempts.current()
        if (running != null && running.configuration == configuration) {
            return awaitAttempt(running)
        }

        val publicKey = try {
            identity.publicKeySpki()
        } catch (_: Exception) {
            return conclude(
                RegistrationState.Failed(RegistrationFailure.IDENTITY_UNAVAILABLE),
                RegistrationOutcome.UNCERTAIN,
            )
        }

        val start = synchronized(RegistrationSerialization.lock) {
            // Zwischen Vorpruefung und Sperre kann ein anderer Start gewonnen haben.
            val raced = attempts.current()
            if (raced != null && raced.configuration == configuration) {
                Start.Joined(raced)
            } else {
                when (val current = store.read()) {
                    is RegistrationState.Registered ->
                        Start.Done(current, RegistrationOutcome.REGISTERED)
                    RegistrationState.NotRegistered -> {
                        val attempt = attempts.begin(configuration)
                        if (store.writeMarker(configuration)) {
                            Start.Owned(attempt)
                        } else {
                            attempts.end(attempt)
                            Start.Done(
                                RegistrationState.Failed(RegistrationFailure.STORAGE_UNAVAILABLE),
                                RegistrationOutcome.UNCERTAIN,
                            )
                        }
                    }
                    else -> Start.Done(current, RegistrationOutcome.UNCERTAIN)
                }
            }
        }

        return when (start) {
            is Start.Done -> conclude(start.state, start.outcome)
            is Start.Joined -> awaitAttempt(start.attempt)
            is Start.Owned -> runAttempt(start.attempt, registrationCode, publicKey)
        }
    }

    private fun awaitAttempt(attempt: RegistrationAttempt): RegistrationState {
        attempt.await()
        return conclude(
            attempt.state ?: RegistrationState.Unknown,
            attempt.outcome ?: RegistrationOutcome.UNCERTAIN,
        )
    }

    private fun runAttempt(
        attempt: RegistrationAttempt,
        registrationCode: String,
        publicKey: ByteArray,
    ): RegistrationState {
        inFlight = true
        try {
            val request = requestFactory.create(
                registrationCode,
                publicKey,
                attempt.clientRequestId,
            )
            val result = try {
                transport(request)
            } catch (failure: Throwable) {
                finishAttempt(attempt, RegistrationState.Unknown, RegistrationOutcome.UNCERTAIN)
                throw failure
            }
            return complete(attempt, result)
        } finally {
            inFlight = false
        }
    }

    /**
     * Abschluss unter derselben Sperre wie ein Konfigurationswechsel. Nur wenn
     * die Generation des Vorgangs noch die aktive ist, wird eine Antwort
     * ausgewertet oder eine Bindung gespeichert.
     */
    private fun complete(
        attempt: RegistrationAttempt,
        result: TransportResult,
    ): RegistrationState {
        val (state, outcome) = synchronized(RegistrationSerialization.lock) {
            val active = configurationStore.current()
            if (active != attempt.configuration) {
                RegistrationState.Unknown to RegistrationOutcome.UNCERTAIN
            } else {
                when (result) {
                    is TransportResult.Failure -> RegistrationState.Unknown to when (result.code) {
                        ErrorCode.NETWORK, ErrorCode.TIMEOUT -> RegistrationOutcome.NETWORK_ERROR
                        else -> RegistrationOutcome.UNCERTAIN
                    }
                    is TransportResult.Response -> evaluate(attempt, result)
                }
            }
        }
        finishAttempt(attempt, state, outcome)
        return conclude(state, outcome)
    }

    /** Wird nur unter [RegistrationSerialization.lock] aufgerufen. */
    private fun evaluate(
        attempt: RegistrationAttempt,
        response: TransportResult.Response,
    ): Pair<RegistrationState, RegistrationOutcome> {
        val deviceId = parseSuccess(response)
        if (deviceId != null) {
            return if (store.writeRegistered(deviceId, attempt.configuration)) {
                RegistrationState.Registered(deviceId, attempt.configuration.baseUrl) to
                    RegistrationOutcome.REGISTERED
            } else {
                RegistrationState.Unknown to RegistrationOutcome.UNCERTAIN
            }
        }
        if (response.status == 429) {
            return RegistrationState.Unknown to RegistrationOutcome.RATE_LIMITED
        }
        if (!isExplicitRejection(response)) {
            return RegistrationState.Unknown to RegistrationOutcome.UNCERTAIN
        }
        return if (store.clearMarker()) {
            RegistrationState.NotRegistered to RegistrationOutcome.CODE_REJECTED
        } else {
            RegistrationState.Unknown to RegistrationOutcome.CODE_REJECTED
        }
    }

    private fun finishAttempt(
        attempt: RegistrationAttempt,
        state: RegistrationState,
        outcome: RegistrationOutcome,
    ) {
        attempt.complete(state, outcome)
        attempts.end(attempt)
    }

    private fun conclude(
        state: RegistrationState,
        outcome: RegistrationOutcome,
    ): RegistrationState {
        lastOutcome = outcome
        return state
    }

    private fun parseSuccess(response: TransportResult.Response): String? {
        if (response.status != 201) return null
        return try {
            val json = JSONObject(String(response.body, Charsets.UTF_8))
            val deviceId = json.getString("device_id")
            if (!UUID_V4.matches(deviceId)) return null
            Instant.parse(json.getString("server_time"))
            if (json.getString("server_env") != appEnv) return null
            val config = json.getJSONObject("config")
            if (config.getInt("api_version") != 1) return null
            if (config.getInt("heartbeat_interval_s") < 1) return null
            deviceId
        } catch (_: Exception) {
            null
        }
    }

    private fun isExplicitRejection(response: TransportResult.Response): Boolean {
        if (response.status !in 400..499 || response.status == 408 || response.status == 429) {
            return false
        }
        return try {
            JSONObject(String(response.body, Charsets.UTF_8))
                .getJSONObject("error")
                .getString("code")
                .isNotBlank()
        } catch (_: Exception) {
            false
        }
    }

    private sealed interface Start {
        data class Done(
            val state: RegistrationState,
            val outcome: RegistrationOutcome,
        ) : Start

        data class Joined(val attempt: RegistrationAttempt) : Start

        data class Owned(val attempt: RegistrationAttempt) : Start
    }

    private companion object {
        val UUID_V4 = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    }
}

/** Bestehendes JSON-Anfrageformat; die Request-ID stammt aus dem einen Vorgang. */
internal class JsonRegistrationRequestFactory(
    private val appEnv: String,
    private val deviceInfo: RegistrationDeviceInfo,
) : RegistrationRequestFactory {
    override fun create(
        registrationCode: String,
        publicKey: ByteArray,
        clientRequestId: String,
    ): ByteArray {
        val info = JSONObject()
            .put("manufacturer", deviceInfo.manufacturer)
            .put("model", deviceInfo.model)
            .put("os_version", deviceInfo.osVersion)
            .put("sdk_int", deviceInfo.sdkInt)
            .put("app_version", deviceInfo.appVersion)
            .put("app_flavor", deviceInfo.appFlavor)
        return JSONObject()
            .put("registration_code", registrationCode)
            .put("client_request_id", clientRequestId)
            .put("public_key", Base64.getEncoder().encodeToString(publicKey))
            .put("app_env", appEnv)
            .put("device_info", info)
            .toString()
            .toByteArray(Charsets.UTF_8)
    }
}
