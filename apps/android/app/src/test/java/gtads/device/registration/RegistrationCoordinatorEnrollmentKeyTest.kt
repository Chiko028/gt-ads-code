package gtads.device.registration

import android.content.Context
import gtads.device.identity.DeviceIdentity
import gtads.device.identity.IdentityKeyStore
import gtads.device.identity.TEST_ALIAS
import gtads.device.identity.TestIdentityKeyStore
import gtads.device.identity.newP256KeyPair
import java.io.File
import java.security.PrivateKey
import java.util.Base64
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Geraetetest-Befund 2026-11-22 (S22+): Auf einem frisch installierten Geraet
 * existiert noch kein Schluessel. Die Registrierung muss ihn einmalig anlegen
 * und darf eine vorhandene Identitaet nie ersetzen.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RegistrationCoordinatorEnrollmentKeyTest {
    private lateinit var context: Context
    private lateinit var file: File

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        file = File(context.noBackupFilesDir, REGISTRATION_FILE_NAME)
        cleanup()
    }

    @After
    fun tearDown() = cleanup()

    private fun cleanup() {
        file.delete()
        File(file.path + ".new").delete()
        File(file.path + ".bak").delete()
    }

    private fun info(): RegistrationDeviceInfo =
        RegistrationDeviceInfo("SYN-Hersteller", "SYN-Modell", "14", 34, "0.1.0", "dev")

    private fun successBody(): ByteArray = JSONObject()
        .put("device_id", DEVICE_ID)
        .put("server_time", "2026-01-01T12:00:00.000Z")
        .put("server_env", "dev")
        .put("config", JSONObject().put("heartbeat_interval_s", 900).put("api_version", 1))
        .toString()
        .toByteArray(Charsets.UTF_8)

    private fun coordinator(
        identity: DeviceIdentity,
        transport: (ByteArray) -> TransportResult,
    ): RegistrationCoordinator =
        RegistrationCoordinator(RegistrationRepository(context), identity, BASE_URL, "dev", info(), transport)

    @Test
    fun freshDeviceWithoutKeyCreatesItOnceAndSendsItsPublicKey() {
        val store = TestIdentityKeyStore()
        var sends = 0
        var requestBytes: ByteArray? = null

        val state = coordinator(DeviceIdentity(store)) { bytes ->
            sends += 1
            requestBytes = bytes
            TransportResult.Response(201, successBody())
        }.register(CODE)

        assertEquals(RegistrationState.Registered(DEVICE_ID, BASE_URL), state)
        assertEquals(1, sends)
        assertEquals(listOf(TEST_ALIAS), store.createdAliases)
        val created = requireNotNull(store.keyPair(TEST_ALIAS))
        val request = JSONObject(String(requestBytes!!, Charsets.UTF_8))
        assertEquals(Base64.getEncoder().encodeToString(created.public.encoded), request.getString("public_key"))
    }

    @Test
    fun existingKeyIsReusedAndNeverReplaced() {
        val existing = newP256KeyPair()
        val store = TestIdentityKeyStore(mapOf(TEST_ALIAS to existing))
        var requestBytes: ByteArray? = null

        coordinator(DeviceIdentity(store)) { bytes ->
            requestBytes = bytes
            TransportResult.Response(201, successBody())
        }.register(CODE)

        assertEquals(0, store.createCalls)
        val request = JSONObject(String(requestBytes!!, Charsets.UTF_8))
        assertEquals(Base64.getEncoder().encodeToString(existing.public.encoded), request.getString("public_key"))
    }

    @Test
    fun keystoreFailureEndsUncertainWithoutRequest() {
        val failing = object : IdentityKeyStore {
            override fun contains(alias: String): Boolean = false
            override fun createP256(alias: String): Unit = throw IllegalStateException("Keystore nicht verfuegbar")
            override fun publicKeySpki(alias: String): ByteArray = throw IllegalStateException("kein Schluessel")
            override fun privateKey(alias: String): PrivateKey = throw IllegalStateException("kein Schluessel")
        }
        var sends = 0

        val c = coordinator(DeviceIdentity(failing)) {
            sends += 1
            TransportResult.Response(201, successBody())
        }
        val state = c.register(CODE)

        assertEquals(RegistrationState.Failed(RegistrationFailure.IDENTITY_UNAVAILABLE), state)
        assertEquals(RegistrationOutcome.UNCERTAIN, c.outcome())
        assertEquals(0, sends)
    }

    private companion object {
        const val CODE = "ABCD-EFGH-JKMN"
        const val BASE_URL = "https://api.example.test/base"
        const val DEVICE_ID = "22222222-2222-4222-8222-222222222222"
    }
}
