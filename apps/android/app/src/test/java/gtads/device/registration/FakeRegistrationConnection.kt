package gtads.device.registration

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Aufzeichnende Verbindung; oeffnet nie einen echten Socket. */
internal class FakeRegistrationConnection(url: URL) : HttpURLConnection(url) {
    var status: Int = 201
    var body: ByteArray = ByteArray(0)
    var errorBody: ByteArray? = null
    var timeoutOnResponse: Boolean = false
    var ioFailureOnResponse: Boolean = false

    val requestBytes = ByteArrayOutputStream()
    var outputStreamCalls: Int = 0
        private set
    var outputClosed: Boolean = false
        private set
    var inputStreamOpened: Boolean = false
        private set
    var errorStreamOpened: Boolean = false
        private set
    var inputClosed: Boolean = false
        private set
    var errorClosed: Boolean = false
        private set
    var inputBytesRead: Int = 0
        private set
    var disconnected: Boolean = false
        private set

    override fun connect() = Unit

    override fun disconnect() {
        disconnected = true
    }

    override fun usingProxy(): Boolean = false

    override fun getOutputStream(): OutputStream {
        outputStreamCalls += 1
        return object : OutputStream() {
            override fun write(value: Int) {
                requestBytes.write(value)
            }

            override fun write(buffer: ByteArray, offset: Int, length: Int) {
                requestBytes.write(buffer, offset, length)
            }

            override fun close() {
                outputClosed = true
            }
        }
    }

    override fun getInputStream(): InputStream {
        inputStreamOpened = true
        return object : ByteArrayInputStream(body) {
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                val read = super.read(buffer, offset, length)
                if (read > 0) inputBytesRead += read
                return read
            }

            override fun close() {
                inputClosed = true
                super.close()
            }
        }
    }

    override fun getErrorStream(): InputStream? {
        val payload = errorBody ?: return null
        errorStreamOpened = true
        return object : ByteArrayInputStream(payload) {
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                val read = super.read(buffer, offset, length)
                if (read > 0) inputBytesRead += read
                return read
            }

            override fun close() {
                errorClosed = true
                super.close()
            }
        }
    }

    override fun getResponseCode(): Int {
        if (timeoutOnResponse) throw SocketTimeoutException("synthetic timeout")
        if (ioFailureOnResponse) throw IOException("synthetic failure")
        return status
    }
}

/** Fuehrt den Transport ausserhalb des Android-Hauptthreads aus. */
internal fun <T> runOnBackground(block: () -> T): T {
    val executor = Executors.newSingleThreadExecutor()
    return try {
        executor.submit(Callable { block() }).get(15, TimeUnit.SECONDS)
    } finally {
        executor.shutdownNow()
    }
}
