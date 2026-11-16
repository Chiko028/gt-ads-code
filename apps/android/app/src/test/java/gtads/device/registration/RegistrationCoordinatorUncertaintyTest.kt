package gtads.device.registration

import android.content.Context
import android.util.AtomicFile
import gtads.device.identity.DeviceIdentity
import gtads.device.identity.TEST_ALIAS
import gtads.device.identity.TestIdentityKeyStore
import gtads.device.identity.newP256KeyPair
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
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
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RegistrationCoordinatorUncertaintyTest {
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

    private fun coordinator(
        repository: RegistrationRepository,
        transport: (ByteArray) -> TransportResult,
    ): RegistrationCoordinator =
        RegistrationCoordinator(repository, identity(), BASE_URL, "dev", info(), transport)

    @Test
    fun overlappingStartsSendOnceAndUncertainOutcomesSurviveRestart() {
        var sends = 0
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val transport: (ByteArray) -> TransportResult = {
            sends += 1
            entered.countDown()
            release.await(5, TimeUnit.SECONDS)
            TransportResult.Response(201, successBody(DEVICE_ID))
        }
        val executor = Executors.newFixedThreadPool(2)
        try {
            val first = executor.submit(Callable { coordinator(RegistrationRepository(context), transport).register(CODE) })
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            val secondStarted = CountDownLatch(1)
            val second = executor.submit(Callable {
                secondStarted.countDown()
                coordinator(RegistrationRepository(context), transport).register(CODE)
            })
            assertTrue(secondStarted.await(5, TimeUnit.SECONDS))
            Thread.sleep(100)
            assertEquals(1, sends)
            release.countDown()
            val firstState = first.get(10, TimeUnit.SECONDS)
            val secondState = second.get(10, TimeUnit.SECONDS)
            assertEquals(1, sends)
            assertEquals(RegistrationState.Registered(DEVICE_ID, BASE_URL), firstState)
            assertEquals(firstState, secondState)
        } finally {
            release.countDown()
            executor.shutdownNow()
        }

        cleanup()
        var timeoutSends = 0
        val timedOut = coordinator(RegistrationRepository(context)) {
            timeoutSends += 1
            TransportResult.Failure(ErrorCode.TIMEOUT)
        }.register(CODE)
        assertEquals(RegistrationState.Unknown, timedOut)
        assertEquals(1, timeoutSends)
        assertTrue(file.exists())
        val marker = file.readText(Charsets.UTF_8)
        assertTrue(marker.contains(BASE_URL))
        assertFalse(marker.contains(CODE))
        assertFalse(marker.contains("Bearer"))
        assertFalse(marker.contains("PRIVATE"))
        assertEquals(RegistrationState.Unknown, RegistrationRepository(context).read())

        var restartSends = 0
        val restarted = coordinator(RegistrationRepository(context)) {
            restartSends += 1
            error("marker must block the send")
        }.register(CODE)
        assertEquals(RegistrationState.Unknown, restarted)
        assertEquals(0, restartSends)

        cleanup()
        val failingRepository = RegistrationRepository(file) { target ->
            if (target.exists()) FailingFinishAtomicFile(target) else AtomicFile(target)
        }
        var completionSends = 0
        val completionFailed = RegistrationCoordinator(
            failingRepository,
            identity(),
            BASE_URL,
            "dev",
            info(),
        ) {
            completionSends += 1
            TransportResult.Response(201, successBody(DEVICE_ID))
        }.register(CODE)
        assertEquals(RegistrationState.Unknown, completionFailed)
        assertEquals(1, completionSends)
        assertTrue(file.readText(Charsets.UTF_8).contains("unknown"))
        assertEquals(RegistrationState.Unknown, RegistrationRepository(context).read())

        var afterSends = 0
        val afterRestart = coordinator(RegistrationRepository(context)) {
            afterSends += 1
            error("marker must block the send")
        }.register(CODE)
        assertEquals(RegistrationState.Unknown, afterRestart)
        assertEquals(0, afterSends)
    }

    /** Reales AtomicFile, dessen lokaler Abschluss kontrolliert scheitert. */
    private class FailingFinishAtomicFile(file: File) : AtomicFile(file) {
        override fun finishWrite(str: FileOutputStream) {
            try {
                str.close()
            } finally {
                throw IOException("synthetic finish failure")
            }
        }
    }

    private companion object {
        const val CODE = "ABCD-EFGH-JKMN"
        const val BASE_URL = "https://api.example.test/base"
        const val DEVICE_ID = "11111111-1111-4111-8111-111111111111"
    }
}
