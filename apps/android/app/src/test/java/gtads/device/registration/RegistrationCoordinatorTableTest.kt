package gtads.device.registration

import android.content.Context
import gtads.device.identity.DeviceIdentity
import gtads.device.identity.TEST_ALIAS
import gtads.device.identity.TestIdentityKeyStore
import gtads.device.identity.newP256KeyPair
import java.io.File
import java.util.Base64
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
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
class RegistrationCoordinatorTableTest {
    private enum class Case { INVALID_ADDRESS, INCOMPLETE_RESPONSE, CORRUPTED_FILE, EXISTING_BINDING }

    private lateinit var context: Context

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
    }

    @After
    fun tearDown() {
        File(context.noBackupFilesDir, "cx071-table").deleteRecursively()
    }

    private fun identity(): DeviceIdentity =
        DeviceIdentity(TestIdentityKeyStore(mapOf(TEST_ALIAS to newP256KeyPair())))

    private fun info(): RegistrationDeviceInfo =
        RegistrationDeviceInfo("SYN-Hersteller", "SYN-Modell", "14", 34, "0.1.0", "dev")

    private fun successBody(deviceId: String): ByteArray = JSONObject()
        .put("device_id", deviceId)
        .put("server_time", "2026-01-01T12:00:00.000Z")
        .put("server_env", "dev")
        .put("config", JSONObject().put("heartbeat_interval_s", 900).put("api_version", 1))
        .toString()
        .toByteArray(Charsets.UTF_8)

    private fun freshFile(case: Case): File {
        val directory = File(File(context.noBackupFilesDir, "cx071-table"), case.name.lowercase())
        directory.mkdirs()
        val result = File(directory, REGISTRATION_FILE_NAME)
        result.delete()
        File(result.path + ".new").delete()
        return result
    }

    @Test
    fun invalidAddressIncompleteResponseCorruptionAndExistingBindingStayRejected() {
        for (case in Case.entries) {
            val file = freshFile(case)
            val baseUrl = if (case == Case.INVALID_ADDRESS) {
                "https://api.example.test/base?query=1"
            } else {
                BASE_URL
            }
            var before: ByteArray? = null
            when (case) {
                Case.CORRUPTED_FILE -> {
                    file.writeBytes("{broken".toByteArray(Charsets.UTF_8))
                    before = file.readBytes()
                }
                Case.EXISTING_BINDING -> {
                    assertTrue(RegistrationRepository(file).writeRegistered(EXISTING_ID, BASE_URL))
                    before = file.readBytes()
                }
                else -> Unit
            }

            var sends = 0
            val coordinator = RegistrationCoordinator(
                RegistrationRepository(file),
                identity(),
                baseUrl,
                "dev",
                info(),
            ) { _ ->
                sends += 1
                if (case == Case.INCOMPLETE_RESPONSE) {
                    TransportResult.Response(201, "{\"device_id\":\"$DEVICE_ID\"}".toByteArray(Charsets.UTF_8))
                } else {
                    TransportResult.Response(201, successBody(DEVICE_ID))
                }
            }

            val state = coordinator.register(CODE)

            when (case) {
                Case.INVALID_ADDRESS -> {
                    assertEquals(RegistrationState.Failed(RegistrationFailure.INVALID_BASE_URL), state)
                    assertEquals(0, sends)
                    assertFalse(file.exists())
                }
                Case.INCOMPLETE_RESPONSE -> {
                    assertEquals(RegistrationState.Unknown, state)
                    assertEquals(1, sends)
                    assertEquals(RegistrationState.Unknown, RegistrationRepository(file).read())
                    assertTrue(file.exists())
                }
                Case.CORRUPTED_FILE -> {
                    assertEquals(RegistrationState.Unknown, state)
                    assertEquals(0, sends)
                    assertArrayEquals(before, file.readBytes())
                }
                Case.EXISTING_BINDING -> {
                    assertEquals(RegistrationState.Registered(EXISTING_ID, BASE_URL), state)
                    assertEquals(0, sends)
                    assertArrayEquals(before, file.readBytes())
                }
            }
            assertFalse(state is RegistrationState.Registered && case != Case.EXISTING_BINDING)
        }
    }

    private companion object {
        const val CODE = "ABCD-EFGH-JKMN"
        const val BASE_URL = "https://api.example.test/base"
        const val DEVICE_ID = "11111111-1111-4111-8111-111111111111"
        const val EXISTING_ID = "22222222-2222-4222-8222-222222222222"
    }
}
