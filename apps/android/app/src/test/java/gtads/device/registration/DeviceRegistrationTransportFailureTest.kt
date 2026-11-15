package gtads.device.registration

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config

enum class TransportScenario {
    TIMEOUT,
    IO_FAILURE,
    TIMEOUT_ON_WRITE,
    IO_FAILURE_ON_WRITE,
    TIMEOUT_ON_READ,
    IO_FAILURE_ON_READ,
    STATUS_302,
    STATUS_401,
    STATUS_429,
    SIZE_262144,
    SIZE_262145,
}

@RunWith(ParameterizedRobolectricTestRunner::class)
@Config(sdk = [34])
class DeviceRegistrationTransportFailureTest(private val scenario: TransportScenario) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters
        fun cases(): List<Array<Any>> = TransportScenario.entries.map { arrayOf<Any>(it) }
    }

    @Test
    fun reportsFixedLocalErrorsOrUnchangedHttpResults() {
        val fake = FakeRegistrationConnection(java.net.URL("https://unused.invalid"))
        when (scenario) {
            TransportScenario.TIMEOUT -> fake.timeoutOnResponse = true
            TransportScenario.IO_FAILURE -> fake.ioFailureOnResponse = true
            TransportScenario.TIMEOUT_ON_WRITE -> fake.timeoutOnWrite = true
            TransportScenario.IO_FAILURE_ON_WRITE -> fake.ioFailureOnWrite = true
            TransportScenario.TIMEOUT_ON_READ -> fake.timeoutOnRead = true
            TransportScenario.IO_FAILURE_ON_READ -> fake.ioFailureOnRead = true
            TransportScenario.STATUS_302 -> fake.status = 302
            TransportScenario.STATUS_401 -> {
                fake.status = 401
                fake.errorBody = "unauthorized".toByteArray()
            }
            TransportScenario.STATUS_429 -> {
                fake.status = 429
                fake.errorBody = "rate_limited".toByteArray()
            }
            TransportScenario.SIZE_262144 -> {
                fake.status = 200
                fake.body = ByteArray(262_144) { (it % 251).toByte() }
            }
            TransportScenario.SIZE_262145 -> {
                fake.status = 200
                fake.body = ByteArray(262_145) { (it % 251).toByte() }
            }
        }
        var opened = 0
        val transport = DeviceRegistrationTransport(
            baseUrl = "https://api.example.test",
            openConnection = { url ->
                opened += 1
                fake
            },
        )

        val result = runOnBackground { transport.send(byteArrayOf(1, 2, 3)) }

        // Genau ein Verbindungsaufbau, genau ein Body und kein zweiter POST.
        assertEquals(1, opened)
        assertEquals(1, fake.outputStreamCalls)
        // Body-Laenge vor dem Oeffnen des Ausgabestreams festgelegt: kein
        // gepufferter, wiederholbarer Request.
        assertEquals(3L, fake.fixedLengthMode ?: -1L)
        assertTrue(fake.streamingModeSetBeforeOutputStream)
        assertTrue(fake.outputClosed)
        assertTrue(fake.disconnected)
        assertTrue(fake.inputBytesRead <= DeviceRegistrationTransport.MAX_RESPONSE_BYTES + 1)

        when (scenario) {
            TransportScenario.TIMEOUT -> {
                assertEquals(TransportResult.Failure(ErrorCode.TIMEOUT), result)
                assertEquals(0, fake.responseCodeCalls)
            }
            TransportScenario.IO_FAILURE -> {
                assertEquals(TransportResult.Failure(ErrorCode.NETWORK), result)
                assertEquals(0, fake.responseCodeCalls)
            }
            TransportScenario.TIMEOUT_ON_WRITE -> {
                assertEquals(TransportResult.Failure(ErrorCode.TIMEOUT), result)
                assertEquals(0, fake.responseCodeCalls)
                assertFalse(fake.inputStreamOpened)
                assertFalse(fake.errorStreamOpened)
            }
            TransportScenario.IO_FAILURE_ON_WRITE -> {
                assertEquals(TransportResult.Failure(ErrorCode.NETWORK), result)
                assertEquals(0, fake.responseCodeCalls)
                assertFalse(fake.inputStreamOpened)
                assertFalse(fake.errorStreamOpened)
            }
            TransportScenario.TIMEOUT_ON_READ -> {
                assertEquals(TransportResult.Failure(ErrorCode.TIMEOUT), result)
                assertEquals(1, fake.responseCodeCalls)
                assertTrue(fake.inputStreamOpened)
                assertTrue(fake.inputClosed)
                assertFalse(fake.errorStreamOpened)
            }
            TransportScenario.IO_FAILURE_ON_READ -> {
                assertEquals(TransportResult.Failure(ErrorCode.NETWORK), result)
                assertEquals(1, fake.responseCodeCalls)
                assertTrue(fake.inputStreamOpened)
                assertTrue(fake.inputClosed)
                assertFalse(fake.errorStreamOpened)
            }
            TransportScenario.SIZE_262145 -> {
                assertEquals(TransportResult.Failure(ErrorCode.RESPONSE_TOO_LARGE), result)
                assertEquals(262_145, fake.inputBytesRead)
                assertTrue(fake.inputClosed)
            }
            else -> {
                assertTrue(result is TransportResult.Response)
                val response = result as TransportResult.Response
                val expected = when (scenario) {
                    TransportScenario.STATUS_302 -> ByteArray(0)
                    TransportScenario.STATUS_401 -> "unauthorized".toByteArray()
                    TransportScenario.STATUS_429 -> "rate_limited".toByteArray()
                    TransportScenario.SIZE_262144 -> fake.body
                    else -> error("unexpected scenario")
                }
                assertEquals(fake.status, response.status)
                assertArrayEquals(expected, response.body)
                if (scenario == TransportScenario.SIZE_262144) {
                    assertEquals(262_144, fake.inputBytesRead)
                    assertTrue(fake.inputClosed)
                }
                if (scenario == TransportScenario.STATUS_401 ||
                    scenario == TransportScenario.STATUS_429
                ) {
                    assertTrue(fake.errorClosed)
                }
            }
        }
    }
}
