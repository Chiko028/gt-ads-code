package gtads.device.playback

import gtads.device.download.MediaDownloader
import gtads.device.manifest.ManifestActivation
import gtads.device.manifest.ManifestRepository
import gtads.device.manifest.ManifestVerification
import gtads.device.manifest.VerifiedMedia
import gtads.device.manifest.verifyManifest
import gtads.device.state.ContentAvailability
import gtads.device.state.DecisionReason
import gtads.device.state.PauseRestore
import gtads.device.state.PlaybackStateCoordinator
import gtads.device.state.PlaybackStateMachine
import gtads.device.state.ReadinessSource
import gtads.device.state.ScheduledTask
import gtads.device.state.StateMachineConfig
import gtads.device.state.VehicleReadiness
import java.io.File
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.time.Instant
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * REV-201: Fallback (CX-092) mit der produktiven Zustandsanbindung (Pause, Fahrzeug aus,
 * Display-Nachlauf) und mit dem echten Aktivierungsweg (ManifestRepository + verifyManifest).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlaybackFallbackIntegrationTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private val start = Instant.parse("2026-12-01T10:00:00Z")
    private val clock = MutableClock(start.plusSeconds(30))
    private var mono = 0L

    private class Readiness(var value: VehicleReadiness) : ReadinessSource {
        private var observer: ((VehicleReadiness) -> Unit)? = null
        override fun current() = value
        override fun start(observer: (VehicleReadiness) -> Unit) { this.observer = observer }
        override fun stop() { observer = null }
        fun emit(next: VehicleReadiness) { value = next; observer?.invoke(next) }
    }

    @Test
    fun pauseVehicleOffAndDisplayGraceSuppressAndRestoreThePlaceholderThroughTheGate() {
        val port = RecordingPlayerPort()
        val states = ArrayList<PlaybackUiState>()
        val readiness = Readiness(VehicleReadiness.ON)
        var paused = false
        val graceTasks = ArrayList<() -> Unit>()
        lateinit var gate: PlaybackStateCoordinator
        lateinit var controller: PlaybackController
        val restore = PauseRestore(read = { paused }, execute = { it() }, onChange = { gate.refresh() })
        gate = PlaybackStateCoordinator(
            machine = PlaybackStateMachine(StateMachineConfig(displayGraceMillis = 60_000L), clock = { mono }),
            readiness = readiness,
            content = { ContentAvailability.VALID },
            displayGraceMillis = 60_000L,
            schedule = { _, action -> graceTasks += action; ScheduledTask { graceTasks.remove(action) } },
            onDecision = { decision -> if (decision.playbackAllowed) controller.start() else controller.stop() },
            pauseRestore = restore,
        )
        controller = PlaybackController(
            adapterFactory = { observer -> LocalMediaPlayerAdapter(temporary.root, port, observer) },
            clock = clock,
            snapshots = { snapshotOf(emptyList()) },
            timer = FakePlaybackTimer(),
            listener = { states += it },
            monotonicMillis = { mono },
            playbackPermitted = { gate.decision()?.playbackAllowed ?: false },
        )

        gate.start()
        assertTrue("Platzhalter sichtbar bei Freigabe ohne Kampagne", controller.isStaticFallback())
        assertEquals(PlaybackUiState.EMPTY, states.last())

        // Fahrzeug aus: Platzhalter unterdrueckt, Display bleibt fuer den Nachlauf an.
        readiness.emit(VehicleReadiness.OFF)
        assertFalse(controller.isStaticFallback())
        assertEquals(PlaybackUiState.IDLE, states.last())
        assertEquals(DecisionReason.VEHICLE_OFF, gate.decision()!!.reason)
        assertTrue(gate.decision()!!.displayRequired)
        assertEquals(1, graceTasks.size)
        // Nachlauf abgelaufen: Display nicht mehr benoetigt, weiterhin kein Platzhalter.
        mono += 60_000L
        graceTasks.removeAt(0)()
        assertFalse(gate.decision()!!.displayRequired)
        assertFalse(controller.isStaticFallback())

        // Fahrzeug an: Platzhalter wieder sichtbar.
        readiness.emit(VehicleReadiness.ON)
        assertTrue(controller.isStaticFallback())

        // Pause ueber die vorhandene Anbindung: unterdrueckt; Fortsetzen: wieder sichtbar.
        paused = true
        restore.update(true)
        gate.refresh()
        assertEquals(DecisionReason.PAUSED, gate.decision()!!.reason)
        assertFalse(controller.isStaticFallback())
        assertEquals(PlaybackUiState.IDLE, states.last())
        paused = false
        restore.update(false)
        gate.refresh()
        assertTrue(controller.isStaticFallback())
        assertEquals(PlaybackUiState.EMPTY, states.last())
        // Der Platzhalter ist nie Kampagnenwiedergabe.
        assertEquals(0, port.playCalls)
    }

    @Test
    fun realActivationReplacesFallbackAndRejectedCandidatesKeepTheActiveContent() {
        val keys: KeyPair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val foreignKeys: KeyPair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val mediaDir = temporary.newFolder("media")
        val repository = ManifestRepository(temporary.newFolder("store"), mediaDir, keys.public, TAXI)
        val port = RecordingPlayerPort()
        val timer = FakePlaybackTimer()
        val states = ArrayList<PlaybackUiState>()
        val controller = PlaybackController(
            adapterFactory = { observer -> LocalMediaPlayerAdapter(mediaDir, port, observer) },
            clock = clock,
            snapshots = { repository.active() ?: snapshotOf(emptyList()) },
            timer = timer,
            listener = { states += it },
            monotonicMillis = { 0L },
        )
        controller.start()
        assertTrue("ohne aktivierten Stand: Platzhalter", controller.isStaticFallback())

        // Gueltiges Manifest mit vollstaendig vorliegendem Medium atomar aktivieren.
        val content = byteArrayOf(1, 2, 3, 4)
        val sha = sha256Hex(content)
        MediaDownloader.targetFile(mediaDir, VerifiedMedia.of("SYN-media-0", sha, content.size.toLong())!!).writeBytes(content)
        val generation = repository.beginRun()!!
        val activated = repository.activate(signed(keys, sha, content.size.toLong()), "\"etag-1\"", generation)
        assertTrue(activated is ManifestActivation.Activated)
        timer.fire()
        assertEquals(PlaybackUiState.PLAYING, states.last())
        assertFalse(controller.isStaticFallback())
        val activeBefore = repository.active()!!.artifactSha256

        // Kandidat mit fehlendem Medium: Aktivierung abgelehnt, aktiver Stand und Wiedergabe bleiben.
        val missing = sha256Hex(byteArrayOf(9, 9))
        val rejected = repository.activate(signed(keys, missing, 2), "\"etag-2\"", repository.beginRun()!!)
        assertTrue(rejected is ManifestActivation.Rejected)
        // Manipulierter Kandidat (fremder Schluessel) besteht die Pruefung nicht und erreicht die Aktivierung nie.
        assertTrue(verifyEnvelope(foreignKeys, keys, sha, content.size.toLong()) is ManifestVerification.Rejected)
        timer.fire()
        assertEquals(activeBefore, repository.active()!!.artifactSha256)
        assertFalse(controller.isStaticFallback())
        assertEquals(PlaybackUiState.PLAYING, states.last())
    }

    private fun envelope(signer: KeyPair, sha: String, size: Long): ByteArray {
        val entry = JSONObject().put("mediaId", "SYN-media-0").put("sha256", sha).put("sizeBytes", size).put("durationMs", 10_000)
            .put("campaignId", "SYN-campaign").put("startAt", "2026-12-01T08:00:00.000Z").put("endAt", "2026-12-01T18:00:00.000Z")
        val payload = JSONObject().put("schemaVersion", 1).put("environment", "dev").put("taxiId", TAXI).put("slotCount", 1)
            .put("entries", JSONArray().put(entry)).toString().toByteArray(Charsets.UTF_8)
        val payloadBase64 = Base64.getEncoder().encodeToString(payload)
        val version = sha256Hex(payload)
        val signature = Signature.getInstance("SHA256withECDSA").run {
            initSign(signer.private); update("gt-ads-manifest-v1\nk1\n$version\n$payloadBase64".toByteArray(Charsets.UTF_8)); sign()
        }
        return JSONObject().put("schemaVersion", 1).put("keyId", "k1").put("version", version).put("payloadBase64", payloadBase64)
            .put("signatureBase64", Base64.getEncoder().encodeToString(signature)).toString().toByteArray(Charsets.UTF_8)
    }

    private fun signed(keys: KeyPair, sha: String, size: Long): ManifestVerification.Verified =
        verifyManifest(envelope(keys, sha, size), keys.public, TAXI) as ManifestVerification.Verified

    private fun verifyEnvelope(signer: KeyPair, trusted: KeyPair, sha: String, size: Long): ManifestVerification =
        verifyManifest(envelope(signer, sha, size), trusted.public, TAXI)

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

    private companion object {
        const val TAXI = "SYN-taxi"
    }
}
