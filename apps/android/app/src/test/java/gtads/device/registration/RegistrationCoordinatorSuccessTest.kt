package gtads.device.registration

import android.content.Context
import gtads.device.identity.DeviceIdentity
import gtads.device.identity.TEST_ALIAS
import gtads.device.identity.TestIdentityKeyStore
import gtads.device.identity.newP256KeyPair
import java.io.File
import java.security.KeyPair
import java.util.Base64
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RegistrationCoordinatorSuccessTest {
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

    private fun identity(keyPair: KeyPair): DeviceIdentity =
        DeviceIdentity(TestIdentityKeyStore(mapOf(TEST_ALIAS to keyPair)))

    private fun info(): RegistrationDeviceInfo =
        RegistrationDeviceInfo("SYN-Hersteller", "SYN-Modell", "14", 34, "0.1.0", "dev")

    private fun successBody(deviceId: String): ByteArray = JSONObject()
        .put("device_id", deviceId)
        .put("server_time", "2026-01-01T12:00:00.000Z")
        .put("server_env", "dev")
        .put("config", JSONObject().put("heartbeat_interval_s", 900).put("api_version", 1))
        .toString()
        .toByteArray(Charsets.UTF_8)

    @Test
    fun successfulCallPersistsCompleteAssignmentAndReloadsIt() {
        val keyPair = newP256KeyPair()
        val deviceId = "11111111-1111-4111-8111-111111111111"
        var sends = 0
        var requestBytes: ByteArray? = null
        val coordinator = RegistrationCoordinator(
            repository = RegistrationRepository(context),
            identity = identity(keyPair),
            baseUrl = BASE_URL,
            appEnv = "dev",
            deviceInfo = info(),
            transport = { bytes ->
                sends += 1
                requestBytes = bytes
                TransportResult.Response(201, successBody(deviceId))
            },
        )

        val state = coordinator.register(CODE)

        assertEquals(RegistrationState.Registered(deviceId, BASE_URL), state)
        assertEquals(1, sends)
        assertTrue(file.exists())
        assertFalse(File(file.path + ".new").exists())
        val stored = file.readText(Charsets.UTF_8)
        assertTrue(stored.contains(deviceId))
        assertTrue(stored.contains(BASE_URL))
        assertFalse(stored.contains(CODE))
        assertFalse(stored.contains("Bearer"))
        assertFalse(stored.contains("PRIVATE"))

        val request = JSONObject(String(requestBytes!!, Charsets.UTF_8))
        assertEquals(CODE, request.getString("registration_code"))
        assertEquals("dev", request.getString("app_env"))
        assertEquals(Base64.getEncoder().encodeToString(keyPair.public.encoded), request.getString("public_key"))
        assertEquals(34, request.getJSONObject("device_info").getInt("sdk_int"))
        assertEquals(
            setOf("registration_code", "client_request_id", "public_key", "app_env", "device_info"),
            request.keys().asSequence().toSet(),
        )

        assertEquals(state, RegistrationRepository(context).read())
        assertEquals(state, coordinator.register(CODE))
        assertEquals(1, sends)
    }

    private companion object {
        const val CODE = "ABCD-EFGH-JKMN"
        const val BASE_URL = "https://api.example.test/base"
    }
}
