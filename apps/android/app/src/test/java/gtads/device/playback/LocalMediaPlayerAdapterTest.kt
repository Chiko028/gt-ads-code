package gtads.device.playback

import gtads.device.download.MediaDownloader
import gtads.device.manifest.ActiveManifest
import gtads.device.manifest.ManifestSlot
import gtads.device.manifest.ParsedManifest
import gtads.device.manifest.VerifiedMedia
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * JVM-/Robolectric-Tests des Produktionsadapters mit injiziertem Player-Port.
 * Es wird kein echter ExoPlayer und kein Decoder verwendet; SDK 34.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LocalMediaPlayerAdapterTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private class RecordingPort : LocalPlayerPort {
        var callbacks: LocalPlayerPort.Callbacks? = null
            private set
        val preparedFiles = ArrayList<File>()
        val preparedGenerations = ArrayList<Long>()
        var audioDisableCalls = 0
        var playCalls = 0
        var stopCalls = 0
        var releaseCalls = 0

        override fun setCallbacks(callbacks: LocalPlayerPort.Callbacks?) {
            this.callbacks = callbacks
        }

        override fun disableAudio() {
            audioDisableCalls++
        }

        override fun prepare(file: File, generation: Long) {
            preparedFiles += file
            preparedGenerations += generation
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
    }

    @Test
    fun preparesOnlyTheEnabledLocalFileAndKeepsAudioDisabled() {
        val directory = temporary.newFolder("private-media")
        val media = mediaFile(directory)
        val snapshot = activeSnapshot(media)
        val port = RecordingPort()
        val events = ArrayList<PlaybackEvent>()
        val adapter = LocalMediaPlayerAdapter(directory, port, PlaybackObserver { events += it })

        val prepared = adapter.prepare(snapshot, decision(snapshot))
        assertTrue("erwartet Prepared, war $prepared", prepared is PrepareResult.Prepared)
        prepared as PrepareResult.Prepared

        assertEquals(1, port.preparedFiles.size)
        val expected = File(directory, "media-${media.sha256}.bin")
        assertEquals(expected.canonicalPath, port.preparedFiles.single().canonicalPath)
        assertEquals(listOf(prepared.generation), port.preparedGenerations)
        assertEquals("Audio muss vor der Vorbereitung deaktiviert werden", 1, port.audioDisableCalls)
        assertEquals("Vorbereiten darf nicht starten", 0, port.playCalls)
        assertTrue(events.isEmpty())

        val start = adapter.play()
        assertTrue("erwartet Started, war $start", start is PlaybackStart.Started)
        assertEquals(prepared.generation, (start as PlaybackStart.Started).generation)
        assertEquals(1, port.playCalls)
        assertEquals(listOf<PlaybackEvent>(PlaybackEvent.Started(prepared.generation)), events)
    }

    @Test
    fun networkContentOutsideAndMissingFilesNeverStartPlayback() {
        val directory = temporary.newFolder("private-media")
        val outside = temporary.newFile("outside.bin").apply { writeBytes(byteArrayOf(9)) }
        val port = RecordingPort()
        val events = ArrayList<PlaybackEvent>()
        val adapter = LocalMediaPlayerAdapter(directory, port, PlaybackObserver { events += it })

        assertRejected(adapter.prepare("https://example.invalid/media.bin"), PlaybackRejection.UNSUPPORTED_SOURCE)
        assertRejected(adapter.prepare("content://gtads.device/media/1"), PlaybackRejection.UNSUPPORTED_SOURCE)
        assertRejected(adapter.prepare("file://${outside.absolutePath}"), PlaybackRejection.UNSUPPORTED_SOURCE)
        assertRejected(adapter.prepare(outside.absolutePath), PlaybackRejection.OUTSIDE_MEDIA_DIRECTORY)
        assertRejected(
            adapter.prepare(File(directory, "../${outside.name}").absolutePath),
            PlaybackRejection.OUTSIDE_MEDIA_DIRECTORY,
        )

        val missing = VerifiedMedia.of("SYN-missing", "a".repeat(64), 4)!!
        assertRejected(
            adapter.prepare(MediaDownloader.targetFile(directory, missing).absolutePath),
            PlaybackRejection.NOT_A_FILE,
        )

        // Ein vorhandenes Medium, das nicht im aktiven Schnappschuss steht, ist nicht freigegeben.
        val active = mediaFile(directory, byteArrayOf(1))
        val snapshot = activeSnapshot(active)
        val unactivated = mediaFile(directory, byteArrayOf(2))
        val unactivatedSlot = slot(1, unactivated)
        assertRejected(
            adapter.prepare(snapshot, PlaybackDecision.Play(unactivatedSlot, unactivatedSlot.endAt)),
            PlaybackRejection.NOT_ACTIVATED,
        )
        val wrongPosition = slot(99, active)
        assertRejected(
            adapter.prepare(snapshot, PlaybackDecision.Play(wrongPosition, wrongPosition.endAt)),
            PlaybackRejection.NOT_ACTIVATED,
        )

        assertEquals(0, port.preparedFiles.size)
        assertEquals(0, port.audioDisableCalls)
        assertEquals(0, port.playCalls)
        assertEquals(0, port.stopCalls)
        assertTrue(adapter.play() is PlaybackStart.Rejected)
        assertEquals(0, port.playCalls)
        assertTrue(events.isEmpty())
    }

    @Test
    fun stopAndReleaseAreIdempotentAndLateCallbacksAreIgnored() {
        val directory = temporary.newFolder("private-media")
        val media = mediaFile(directory)
        val snapshot = activeSnapshot(media)
        val play = decision(snapshot)
        val port = RecordingPort()
        val events = ArrayList<PlaybackEvent>()
        val adapter = LocalMediaPlayerAdapter(directory, port, PlaybackObserver { events += it })

        val first = (adapter.prepare(snapshot, play) as PrepareResult.Prepared).generation
        assertTrue(adapter.play() is PlaybackStart.Started)
        adapter.stop()
        adapter.stop()
        assertEquals("Stoppen muss idempotent sein", 1, port.stopCalls)

        port.callbacks!!.onEnded(first)
        port.callbacks!!.onError(first, PlaybackRejection.PLAYER_ERROR)
        assertEquals(listOf<PlaybackEvent>(PlaybackEvent.Started(first)), events)

        val second = (adapter.prepare(snapshot, play) as PrepareResult.Prepared).generation
        assertTrue(second > first)
        assertTrue(adapter.play() is PlaybackStart.Started)
        val third = (adapter.prepare(snapshot, play) as PrepareResult.Prepared).generation
        assertTrue(third > second)
        assertEquals("Austausch muss die alte Wiedergabe stoppen", 2, port.stopCalls)
        assertTrue(adapter.play() is PlaybackStart.Started)

        // Verspaeteter Abschluss der ersetzten zweiten Wiedergabe wird ignoriert.
        port.callbacks!!.onEnded(second)
        assertEquals(3, events.size)

        // Nur die aktuelle Generation darf ein Ende melden.
        port.callbacks!!.onEnded(third)
        assertEquals(4, events.size)
        assertEquals(PlaybackEvent.Ended(third), events.last())

        val callback = port.callbacks!!
        adapter.release()
        adapter.release()
        assertEquals("Freigeben muss idempotent sein", 1, port.releaseCalls)
        adapter.stop()
        assertEquals("Nach der Freigabe darf nicht erneut gestoppt werden", 2, port.stopCalls)

        // Auch nach der Freigabe bleiben alte Callbacks wirkungslos.
        callback.onEnded(third)
        callback.onError(third, PlaybackRejection.PLAYER_ERROR)
        assertEquals(4, events.size)
        assertRejected(adapter.prepare(snapshot, play), PlaybackRejection.RELEASED)
        assertTrue(events.all { it !is PlaybackEvent.Failed })
    }

    private fun assertRejected(result: PrepareResult, reason: PlaybackRejection) {
        assertTrue("erwartet Rejected($reason), war $result", result is PrepareResult.Rejected)
        assertEquals(reason, (result as PrepareResult.Rejected).reason)
    }

    private fun activeSnapshot(media: VerifiedMedia): ActiveManifest {
        val manifestSlot = slot(0, media)
        return ActiveManifest(
            byteArrayOf(1),
            "0".repeat(64),
            "\"SYN-etag\"",
            ParsedManifest(listOf(media), listOf(manifestSlot)),
        )
    }

    private fun slot(position: Int, media: VerifiedMedia): ManifestSlot {
        val start = Instant.parse("2026-12-01T10:00:00Z")
        return ManifestSlot(position, media, 10_000, "SYN-campaign-$position", start, start.plusSeconds(60))
    }

    private fun decision(snapshot: ActiveManifest): PlaybackDecision.Play {
        val manifestSlot = snapshot.slots.single()
        return PlaybackDecision.Play(manifestSlot, manifestSlot.endAt)
    }

    private fun mediaFile(directory: File, bytes: ByteArray = byteArrayOf(1, 2, 3)): VerifiedMedia {
        val sha256 = sha256Hex(bytes)
        File(directory, "media-$sha256.bin").writeBytes(bytes)
        return VerifiedMedia.of("SYN-media-${sha256.take(8)}", sha256, bytes.size.toLong())!!
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
}

