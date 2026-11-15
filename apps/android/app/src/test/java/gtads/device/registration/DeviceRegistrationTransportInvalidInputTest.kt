package gtads.device.registration

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(ParameterizedRobolectricTestRunner::class)
@Config(sdk = [34])
class DeviceRegistrationTransportInvalidInputTest(private val baseUrl: String) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters
        fun cases(): List<Array<Any>> = listOf(
            arrayOf<Any>("http://api.example.test"),
            arrayOf<Any>("https:///v1/device/register"),
            arrayOf<Any>("https://user@api.example.test"),
            arrayOf<Any>("https://api.example.test/base?query=1"),
            arrayOf<Any>("https://api.example.test/base#fragment"),
        )
    }

    @Test
    fun rejectsInputBeforeOpeningAConnection() {
        var opened = 0
        val transport = DeviceRegistrationTransport(
            baseUrl = baseUrl,
            openConnection = { url ->
                opened += 1
                FakeRegistrationConnection(url)
            },
        )

        val result = runOnBackground { transport.send(byteArrayOf(1, 2, 3)) }

        assertEquals(TransportResult.Failure(ErrorCode.INVALID_INPUT), result)
        assertEquals(0, opened)
    }
}
