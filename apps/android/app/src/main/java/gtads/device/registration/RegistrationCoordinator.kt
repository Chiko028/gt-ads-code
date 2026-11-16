package gtads.device.registration

import gtads.device.identity.DeviceIdentity
import java.net.URL
import java.time.Instant
import java.util.Base64
import java.util.UUID
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
 */
class RegistrationCoordinator(
    private val repository: RegistrationRepository,
    private val identity: DeviceIdentity,
    private val baseUrl: String,
    private val appEnv: String,
    private val deviceInfo: RegistrationDeviceInfo,
    private val transport: (ByteArray) -> TransportResult =
        { DeviceRegistrationTransport(baseUrl).send(it) },
) {
    @Volatile
    private var inFlight = false

    @Volatile
    private var lastOutcome: RegistrationOutcome? = null

    /** Anzeigekategorie des letzten Versuchs; nie Rohtext oder Serverinhalt. */
    fun outcome(): RegistrationOutcome? = lastOutcome

    fun state(): RegistrationState =
        if (inFlight) RegistrationState.Registering else repository.read()

    fun register(registrationCode: String): RegistrationState =
        synchronized(PROCESS_LOCK) { attempt(registrationCode) }

    private fun attempt(registrationCode: String): RegistrationState {
        val current = repository.read()
        if (current != RegistrationState.NotRegistered) {
            return conclude(
                current,
                if (current is RegistrationState.Registered) {
                    RegistrationOutcome.REGISTERED
                } else {
                    RegistrationOutcome.UNCERTAIN
                },
            )
        }
        if (!isValidBaseUrl()) {
            return conclude(
                RegistrationState.Failed(RegistrationFailure.INVALID_BASE_URL),
                RegistrationOutcome.INVALID_INPUT,
            )
        }
        val publicKey = try {
            identity.publicKeySpki()
        } catch (_: Exception) {
            return conclude(
                RegistrationState.Failed(RegistrationFailure.IDENTITY_UNAVAILABLE),
                RegistrationOutcome.UNCERTAIN,
            )
        }
        val request = buildRequest(registrationCode, publicKey)
        inFlight = true
        try {
            if (!repository.writeMarker(baseUrl)) {
                return conclude(
                    RegistrationState.Failed(RegistrationFailure.STORAGE_UNAVAILABLE),
                    RegistrationOutcome.UNCERTAIN,
                )
            }
            return when (val result = transport(request)) {
                is TransportResult.Failure -> conclude(
                    RegistrationState.Unknown,
                    when (result.code) {
                        ErrorCode.NETWORK, ErrorCode.TIMEOUT -> RegistrationOutcome.NETWORK_ERROR
                        else -> RegistrationOutcome.UNCERTAIN
                    },
                )
                is TransportResult.Response -> complete(result)
            }
        } finally {
            inFlight = false
        }
    }

    private fun complete(response: TransportResult.Response): RegistrationState {
        val deviceId = parseSuccess(response)
        if (deviceId != null) {
            return if (repository.writeRegistered(deviceId, baseUrl)) {
                conclude(
                    RegistrationState.Registered(deviceId, baseUrl),
                    RegistrationOutcome.REGISTERED,
                )
            } else {
                conclude(RegistrationState.Unknown, RegistrationOutcome.UNCERTAIN)
            }
        }
        if (response.status == 429) {
            return conclude(RegistrationState.Unknown, RegistrationOutcome.RATE_LIMITED)
        }
        if (!isExplicitRejection(response)) {
            return conclude(RegistrationState.Unknown, RegistrationOutcome.UNCERTAIN)
        }
        return if (repository.clearMarker()) {
            conclude(RegistrationState.NotRegistered, RegistrationOutcome.CODE_REJECTED)
        } else {
            conclude(RegistrationState.Unknown, RegistrationOutcome.CODE_REJECTED)
        }
    }

    private fun conclude(
        state: RegistrationState,
        outcome: RegistrationOutcome,
    ): RegistrationState {
        lastOutcome = outcome
        return state
    }

    private fun isValidBaseUrl(): Boolean {
        val url = try {
            URL(baseUrl)
        } catch (_: Exception) {
            return false
        }
        return url.protocol.equals("https", ignoreCase = true) &&
            !url.host.isNullOrBlank() &&
            url.userInfo == null &&
            url.query == null &&
            url.ref == null
    }

    private fun buildRequest(registrationCode: String, publicKey: ByteArray): ByteArray {
        val info = JSONObject()
            .put("manufacturer", deviceInfo.manufacturer)
            .put("model", deviceInfo.model)
            .put("os_version", deviceInfo.osVersion)
            .put("sdk_int", deviceInfo.sdkInt)
            .put("app_version", deviceInfo.appVersion)
            .put("app_flavor", deviceInfo.appFlavor)
        return JSONObject()
            .put("registration_code", registrationCode)
            .put("client_request_id", UUID.randomUUID().toString())
            .put("public_key", Base64.getEncoder().encodeToString(publicKey))
            .put("app_env", appEnv)
            .put("device_info", info)
            .toString()
            .toByteArray(Charsets.UTF_8)
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

    private companion object {
        val PROCESS_LOCK = Any()
        val UUID_V4 = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    }
}
