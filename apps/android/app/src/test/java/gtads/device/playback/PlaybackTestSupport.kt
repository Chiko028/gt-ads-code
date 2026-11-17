package gtads.device.playback

import android.view.View
import gtads.device.manifest.ActiveManifest
import gtads.device.manifest.ManifestSlot
import gtads.device.manifest.ParsedManifest
import gtads.device.manifest.VerifiedMedia
import java.io.File
import java.security.MessageDigest
import java.time.Clock
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * Gemeinsame, deterministische Fixtures der CX-082-Tests. Es gibt keine
 * echten Sleeps, keinen Netzaufruf und keinen echten ExoPlayer.
 */
internal class FakePlaybackTimer : PlaybackTimer {
    val delays = ArrayList<Long>()
    var active = false
        private set
    var cancels = 0
        private set
    private var action: (() -> Unit)? = null

    override fun schedule(delayMs: Long, action: () -> Unit): PlaybackTimer.Cancellable {
        delays += delayMs
        this.action = action
        active = true
        var cancelled = false
        val scheduled = action
        return object : PlaybackTimer.Cancellable {
            override fun cancel() {
                if (cancelled) return
                cancelled = true
                cancels++
                if (this@FakePlaybackTimer.action === scheduled) {
                    this@FakePlaybackTimer.action = null
                    active = false
                }
            }
        }
    }

    fun fire() {
        val next = action ?: throw AssertionError("kein geplanter Timer")
        action = null
        active = false
        next()
    }
}

internal class MutableClock(var now: Instant) : Clock() {
    override fun getZone(): ZoneId = ZoneOffset.UTC
    override fun withZone(zone: ZoneId?): Clock = this
    override fun instant(): Instant = now
}

/** Player-Port ohne Media3; zeichnet nur auf, was der Adapter/Controller tut. */
internal class RecordingPlayerPort : LocalPlayerPort {
    var callbacks: LocalPlayerPort.Callbacks? = null
        private set
    val prepared = ArrayList<File>()
    var lastGeneration = 0L
        private set
    var playCalls = 0
        private set
    var stopCalls = 0
        private set
    var releaseCalls = 0
        private set
    var attachCalls = 0
        private set

    override fun setCallbacks(callbacks: LocalPlayerPort.Callbacks?) {
        this.callbacks = callbacks
    }

    override fun disableAudio() {}

    override fun prepare(file: File, generation: Long) {
        prepared += file
        lastGeneration = generation
    }

    override fun play() {
        playCalls++
    }

    override fun stop() {
        stopCalls++
    }

    override fun release() {
        releaseCalls++
    }

    override fun attachView(view: View?) {
        attachCalls++
    }
}

internal fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

internal fun mediaFixture(directory: File, bytes: ByteArray): VerifiedMedia {
    val sha = sha256Hex(bytes)
    File(directory, "media-$sha.bin").writeBytes(bytes)
    return VerifiedMedia.of("SYN-$sha", sha, bytes.size.toLong())!!
}

internal fun mediaPath(directory: File, media: VerifiedMedia): File =
    File(directory, "media-${media.sha256}.bin")

internal fun snapshotOf(
    slots: List<ManifestSlot>,
    media: List<VerifiedMedia> = slots.map { it.media },
): ActiveManifest = ActiveManifest(
    byteArrayOf(1),
    "0".repeat(64),
    "SYN-etag",
    ParsedManifest(media, slots),
)

internal fun manifestSlot(
    position: Int,
    media: VerifiedMedia,
    durationMs: Long,
    startAt: Instant,
    endAt: Instant,
): ManifestSlot =
    ManifestSlot(position, media, durationMs, "SYN-campaign-$position", startAt, endAt)
