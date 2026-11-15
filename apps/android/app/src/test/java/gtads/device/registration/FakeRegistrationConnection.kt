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
    var timeoutOnWrite: Boolean = false
    var ioFailureOnWrite: Boolean = false
    var timeoutOnRead: Boolean = false
    var ioFailureOnRead: Boolean = false

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
    var responseCodeCalls: Int = 0
        private set
    var disconnected: Boolean = false
        private set

    /** Aufgezeichneter Streaming-Modus; die Basisklasse oeffnet keinen Socket. */
    var fixedLengthMode: Long? = null
        private set
    var streamingModeSetBeforeOutputStream: Boolean = false
        private set

    override fun connect() = Unit

    override fun disconnect() {
        disconnected = true
    }

    override fun usingProxy(): Boolean = false

    override fun setFixedLengthStreamingMode(contentLength: Int) {
        fixedLengthMode = contentLength.toLong()
    }

    override fun setFixedLengthStreamingMode(contentLength: Long) {
        fixedLengthMode = contentLength
    }

    override fun getOutputStream(): OutputStream {
        outputStreamCalls += 1
        streamingModeSetBeforeOutputStream = fixedLengthMode != null
        return object : OutputStream() {
            override fun write(value: Int) {
                failWriteIfConfigured()
                requestBytes.write(value)
            }

            override fun write(buffer: ByteArray, offset: Int, length: Int) {
                failWriteIfConfigured()
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
                failReadIfConfigured()
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
                failReadIfConfigured()
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
        responseCodeCalls += 1
        if (timeoutOnResponse) throw SocketTimeoutException("synthetic timeout")
        if (ioFailureOnResponse) throw IOException("synthetic failure")
        return status
    }

    private fun failWriteIfConfigured() {
        if (timeoutOnWrite) throw SocketTimeoutException("synthetic write timeout")
        if (ioFailureOnWrite) throw IOException("synthetic write failure")
    }

    private fun failReadIfConfigured() {
        if (timeoutOnRead) throw SocketTimeoutException("synthetic read timeout")
        if (ioFailureOnRead) throw IOException("synthetic read failure")
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
