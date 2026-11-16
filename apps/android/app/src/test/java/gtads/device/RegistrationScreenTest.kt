package gtads.device

import android.content.Context
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import gtads.device.identity.DeviceIdentity
import gtads.device.identity.TEST_ALIAS
import gtads.device.identity.TestIdentityKeyStore
import gtads.device.identity.newP256KeyPair
import gtads.device.registration.REGISTRATION_FILE_NAME
import gtads.device.registration.RegistrationCoordinator
import gtads.device.registration.RegistrationDeviceInfo
import gtads.device.registration.RegistrationRepository
import gtads.device.registration.RegistrationState
import gtads.device.registration.TransportResult
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RegistrationScreenTest {
    private lateinit var context: Context
    private lateinit var file: File
    private var executor: ExecutorService? = null

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        file = File(context.noBackupFilesDir, REGISTRATION_FILE_NAME)
        deleteStored()
        RegistrationProcess.resetForTest()
    }

    @After
    fun tearDown() {
        RegistrationProcess.resetForTest()
        executor?.shutdownNow()
        deleteStored()
    }

    private fun deleteStored() {
        file.delete()
        File(file.path + ".new").delete()
        File(file.path + ".bak").delete()
    }

    private fun configure(transport: (ByteArray) -> TransportResult): ExecutorService {
        val created = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "test-registration").apply { isDaemon = true }
        }
        executor = created
        RegistrationProcess.configureForTest(
            { ctx, baseUrl ->
                RegistrationCoordinator(
                    repository = RegistrationRepository(ctx),
                    identity = DeviceIdentity(
                        TestIdentityKeyStore(mapOf(TEST_ALIAS to newP256KeyPair())),
                    ),
                    baseUrl = baseUrl,
                    appEnv = "dev",
                    deviceInfo = RegistrationDeviceInfo(
                        "SYN-Hersteller",
                        "SYN-Modell",
                        "14",
                        34,
                        "0.1.0",
                        "dev",
                    ),
                    transport = transport,
                )
            },
            created,
        )
        return created
    }

    private fun successBody(deviceId: String): ByteArray = JSONObject()
        .put("device_id", deviceId)
        .put("server_time", "2026-01-01T12:00:00.000Z")
        .put("server_env", "dev")
        .put("config", JSONObject().put("heartbeat_interval_s", 900).put("api_version", 1))
        .toString()
        .toByteArray(Charsets.UTF_8)

    private fun MainActivity.status(): String =
        findViewById<TextView>(R.id.registration_status).text.toString()

    private fun MainActivity.codeText(): String =
        findViewById<EditText>(R.id.registration_code_input).text.toString()

    @Test
    fun validInputsStartExactlyOneAttemptAndShowStoredDeviceId() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        var sends = 0
        configure {
            sends += 1
            entered.countDown()
            release.await(5, TimeUnit.SECONDS)
            TransportResult.Response(201, successBody(DEVICE_ID))
        }

        val controller = Robolectric.buildActivity(MainActivity::class.java)
        try {
            controller.setup()
            val activity = controller.get()
            awaitUi {
                activity.findViewById<Button>(R.id.registration_button).isEnabled &&
                    activity.status() == activity.getString(R.string.registration_message_not_registered)
            }

            activity.findViewById<EditText>(R.id.server_url_input).setText(BASE_URL)
            activity.findViewById<EditText>(R.id.registration_code_input).setText(CODE)
            activity.findViewById<Button>(R.id.registration_button).performClick()

            // Der Transport laeuft auf dem einzelnen Hintergrund-Executor.
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            idleMain()

            // Waehrend des Versuchs: gesperrte Schaltflaeche, geleertes Codefeld.
            assertFalse(activity.findViewById<Button>(R.id.registration_button).isEnabled)
            assertEquals("", activity.codeText())
            assertEquals("Registrierung laeuft", activity.status())
            assertEquals(1, sends)

            release.countDown()
            awaitUi {
                activity.findViewById<TextView>(R.id.registered_device_id).text.toString() == DEVICE_ID
            }
            idleMain()

            assertEquals(DEVICE_ID, activity.findViewById<TextView>(R.id.registered_device_id).text.toString())
            assertEquals(BASE_URL, activity.findViewById<TextView>(R.id.registered_server_url).text.toString())
            assertEquals(1, sends)
            assertEquals(
                RegistrationState.Registered(DEVICE_ID, BASE_URL),
                RegistrationRepository(context).read(),
            )
        } finally {
            release.countDown()
            controller.destroy()
        }
    }

    @Test
    fun recreationKeepsNoCodeSendsNoSecondRequestAndShowsStoredOrUnknownState() {
        // (1) Persistierte Registrierung wird ohne Request geladen und ueberlebt die Neuerstellung.
        assertTrue(RegistrationRepository(context).writeRegistered(DEVICE_ID, BASE_URL))
        configure { error("Bei registriertem Geraet darf kein Request entstehen") }

        val registeredController = Robolectric.buildActivity(MainActivity::class.java)
        try {
            registeredController.setup()
            awaitUi {
                registeredController.get().findViewById<TextView>(R.id.registered_device_id)
                    .text.toString() == DEVICE_ID
            }
            assertEquals(
                BASE_URL,
                registeredController.get().findViewById<TextView>(R.id.registered_server_url).text.toString(),
            )
            assertEquals("", registeredController.get().codeText())

            registeredController.recreate()
            awaitUi {
                registeredController.get().findViewById<TextView>(R.id.registered_device_id)
                    .text.toString() == DEVICE_ID
            }
            assertEquals(
                BASE_URL,
                registeredController.get().findViewById<TextView>(R.id.registered_server_url).text.toString(),
            )
            assertEquals("", registeredController.get().codeText())
        } finally {
            registeredController.destroy()
        }

        // (2) Neuerstellung waehrend eines laufenden Versuchs.
        deleteStored()
        RegistrationProcess.resetForTest()
        executor?.shutdownNow()
        executor = null

        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        var sends = 0
        configure {
            sends += 1
            entered.countDown()
            release.await(5, TimeUnit.SECONDS)
            // Unvollstaendige Erfolgsantwort: Ergebnis bleibt unklar.
            TransportResult.Response(201, JSONObject().put("device_id", DEVICE_ID).toString().toByteArray())
        }

        val controller = Robolectric.buildActivity(MainActivity::class.java)
        try {
            controller.setup()
            val activity = controller.get()
            awaitUi {
                activity.findViewById<Button>(R.id.registration_button).isEnabled &&
                    activity.status() == activity.getString(R.string.registration_message_not_registered)
            }
            activity.findViewById<EditText>(R.id.server_url_input).setText(BASE_URL)
            activity.findViewById<EditText>(R.id.registration_code_input).setText(CODE)
            activity.findViewById<Button>(R.id.registration_button).performClick()
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            idleMain()

            // Saved State enthaelt den Code nicht.
            val saved = Bundle()
            controller.saveInstanceState(saved)
            assertFalse(bundleContains(saved, CODE))
            assertFalse(saved.toString().contains(CODE))

            controller.recreate()
            idleMain()
            val recreated = controller.get()
            awaitUi { recreated.status() == recreated.getString(R.string.registration_message_progress) }
            assertEquals("", recreated.codeText())
            assertFalse(recreated.findViewById<Button>(R.id.registration_button).isEnabled)
            assertEquals(1, sends)

            release.countDown()
            awaitUi { recreated.status() == recreated.getString(R.string.registration_message_unknown) }
            assertEquals(1, sends)
            assertEquals(RegistrationState.Unknown, RegistrationRepository(context).read())
            assertEquals("", recreated.codeText())
            assertFalse(bundleContains(saved, CODE))
        } finally {
            release.countDown()
            controller.destroy()
        }
    }

    private companion object {
        const val CODE = "ABCD-EFGH-JKMN"
        const val BASE_URL = "https://api.example.test/base"
        const val DEVICE_ID = "11111111-1111-4111-8111-111111111111"
    }
}
