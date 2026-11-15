package gtads.device.registration

import android.os.Looper
import java.net.URL
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DeviceRegistrationTransportSuccessTest {
    private fun fixtureBytes(): ByteArray {
        val stream = javaClass.classLoader
            ?.getResourceAsStream("registration/device-register.request.json")
        assertNotNull("Fixture registration/device-register.request.json fehlt", stream)
        return stream!!.use { it.readBytes() }
    }

    @Test
    fun sendsFixtureBytesOnceAndKeepsStatusAndBodyUnchanged() {
        val fixture = fixtureBytes()
        val expectedBody = "{\"device_id\":\"SYN-070\"}".toByteArray(Charsets.UTF_8)
        val fake = FakeRegistrationConnection(URL("https://unused.invalid"))
        fake.status = 201
        fake.body = expectedBody
        var opened: URL? = null
        val transport = DeviceRegistrationTransport(
            baseUrl = "https://api.example.test/base",
            openConnection = { url ->
                opened = url
                fake
            },
        )

        val result = runOnBackground { transport.send(fixture) }

        assertTrue(result is TransportResult.Response)
        val response = result as TransportResult.Response
        assertEquals(201, response.status)
        assertArrayEquals(expectedBody, response.body)
        assertEquals("https://api.example.test/base/v1/device/register", opened.toString())
        assertEquals("POST", fake.requestMethod)
        assertEquals(1, fake.outputStreamCalls)
        assertArrayEquals(fixture, fake.requestBytes.toByteArray())
        assertEquals("application/json; charset=UTF-8", fake.getRequestProperty("Content-Type"))
        assertEquals("1", fake.getRequestProperty("X-GT-Ads-Api-Version"))
        assertEquals(10_000, fake.connectTimeout)
        assertEquals(15_000, fake.readTimeout)
        assertFalse(fake.instanceFollowRedirects)
        assertTrue(fake.outputClosed)
        assertTrue(fake.inputStreamOpened)
        assertTrue(fake.inputClosed)
        assertFalse(fake.errorStreamOpened)
        assertTrue(fake.disconnected)
    }

    @Test
    fun rejectsTheAndroidMainThreadBeforeOpeningAConnection() {
        var opened = 0
        val transport = DeviceRegistrationTransport(
            baseUrl = "https://api.example.test",
            openConnection = { url ->
                opened += 1
                FakeRegistrationConnection(url)
            },
        )

        assertEquals(Looper.getMainLooper(), Looper.myLooper())
        val result = transport.send(byteArrayOf(1, 2, 3))

        assertEquals(TransportResult.Failure(ErrorCode.MAIN_THREAD), result)
        assertEquals(0, opened)
    }
}
