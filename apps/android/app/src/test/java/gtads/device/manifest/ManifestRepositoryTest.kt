package gtads.device.manifest

import gtads.device.download.MediaDownloader
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ManifestRepositoryTest {
    private val keyPair: KeyPair = KeyPairGenerator.getInstance("EC").apply {
        initialize(ECGenParameterSpec("secp256r1"))
    }.generateKeyPair()

    private lateinit var root: File
    private lateinit var store: File
    private lateinit var media: File
    private var failBeforeSwap = false

    @Before
    fun setUp() {
        root = Files.createTempDirectory("cx076").toFile()
        store = File(root, "store")
        media = File(root, "media")
        media.mkdirs()
    }

    @After
    fun tearDown() {
        root.deleteRecursively()
    }

    private fun repository() = ManifestRepository(store, media, keyPair.public, TAXI_ID) {
        if (failBeforeSwap) throw IOException("SYN-injected")
    }

    /** Legt ein Medium so ab, wie CX-075 es nach vollstaendiger Pruefung benennt. */
    private fun putMedia(content: ByteArray): Pair<String, Long> {
        val sha = sha256Hex(content)
        val item = VerifiedMedia.of("SYN-$sha", sha, content.size.toLong())!!
        MediaDownloader.targetFile(media, item).writeBytes(content)
        return sha to content.size.toLong()
    }

    private fun manifest(vararg items: Pair<String, Long>): ManifestVerification.Verified {
        val entries = JSONArray()
        items.forEachIndexed { index, (sha, size) ->
            entries.put(
                JSONObject()
                    .put("mediaId", "SYN-media-$index")
                    .put("sha256", sha)
                    .put("sizeBytes", size)
                    .put("durationMs", 5000)
                    .put("campaignId", "SYN-campaign")
                    .put("startAt", "2026-12-01T08:00:00.000Z")
                    .put("endAt", "2026-12-01T18:00:00.000Z"),
            )
        }
        val payload = JSONObject()
            .put("schemaVersion", 1)
            .put("environment", "dev")
            .put("taxiId", TAXI_ID)
            .put("slotCount", items.size)
            .put("entries", entries)
            .toString().toByteArray(Charsets.UTF_8)
        val payloadBase64 = Base64.getEncoder().encodeToString(payload)
        val version = sha256Hex(payload)
        val signature = Signature.getInstance("SHA256withECDSA").run {
            initSign(keyPair.private)
            update("gt-ads-manifest-v1\n$KEY_ID\n$version\n$payloadBase64".toByteArray(Charsets.UTF_8))
            sign()
        }
        val envelope = JSONObject()
            .put("schemaVersion", 1)
            .put("keyId", KEY_ID)
            .put("version", version)
            .put("payloadBase64", payloadBase64)
            .put("signatureBase64", Base64.getEncoder().encodeToString(signature))
            .toString().toByteArray(Charsets.UTF_8)
        return verifyManifest(envelope, keyPair.public, TAXI_ID) as ManifestVerification.Verified
    }

    @Test
    fun completeCandidateIsActivatedAtomicallyAndReloadedWithEtagAfterRestart() {
        val first = putMedia("SYN-video-1".toByteArray())
        val second = putMedia("SYN-video-2-longer".toByteArray())
        val candidate = manifest(first, second, first)

        val repository = repository()
        assertEquals(ManifestLoad.Empty, repository.load())
        val result = repository.activate(candidate, "\"SYN-etag-1\"")
        assertTrue(result is ManifestActivation.Activated)
        val snapshot = repository.active()!!
        assertSame((result as ManifestActivation.Activated).active, snapshot)
        assertEquals(listOf(first.first, second.first), snapshot.media.map { it.sha256 })

        // Leser behalten einen unveraenderlichen Schnappschuss.
        val copy = snapshot.bytes()
        copy[0] = (copy[0].toInt() xor 0x7f).toByte()
        assertArrayEquals(candidate.bytes(), snapshot.bytes())

        // Neue Instanz: nur der atomar veroeffentlichte Zeiger zaehlt, Artefakt wird erneut geprueft.
        val restarted = repository()
        val loaded = restarted.load()
        assertTrue(loaded is ManifestLoad.Active)
        val reloaded = (loaded as ManifestLoad.Active).active
        assertArrayEquals(candidate.bytes(), reloaded.bytes())
        assertEquals("\"SYN-etag-1\"", reloaded.etag)
        assertEquals(snapshot.artifactSha256, reloaded.artifactSha256)
        assertEquals(listOf(first, second), reloaded.media.map { it.sha256 to it.sizeBytes })

        // Identisches Artefakt loest keine neue Aktivierung aus.
        assertEquals(ManifestActivation.Unchanged, restarted.activate(candidate, "\"SYN-etag-2\""))
        assertEquals("\"SYN-etag-1\"", repository().let { it.load(); it.active()!!.etag })
    }

    private class FailureCase(
        val name: String,
        val prepare: () -> ManifestVerification.Verified,
        val expected: ManifestStoreFailure,
        val injectBeforeSwap: Boolean = false,
    )

    @Test
    fun failuresLeaveActiveStateUnchangedAndOrphansAreNeverActivated() {
        val base = manifest(putMedia("SYN-base".toByteArray()))
        val repository = repository()
        assertTrue(repository.activate(base, "\"SYN-base\"") is ManifestActivation.Activated)
        val before = repository.active()!!

        val cases = listOf(
            FailureCase("fehlendes Medium", {
                val present = putMedia("SYN-present".toByteArray())
                manifest(present, sha256Hex("SYN-absent".toByteArray()) to 10L)
            }, ManifestStoreFailure.MEDIA_MISSING),
            FailureCase("beschaedigte Datei", {
                val good = "SYN-original".toByteArray()
                val (sha, size) = putMedia(good)
                val item = VerifiedMedia.of("SYN-x", sha, size)!!
                MediaDownloader.targetFile(media, item).writeBytes("SYN-tampered".toByteArray())
                manifest(sha to size)
            }, ManifestStoreFailure.MEDIA_CORRUPT),
            FailureCase("Fehler vor Zeigerwechsel", {
                manifest(putMedia("SYN-orphan".toByteArray()))
            }, ManifestStoreFailure.STORAGE, injectBeforeSwap = true),
        )

        for (case in cases) {
            val candidate = case.prepare()
            failBeforeSwap = case.injectBeforeSwap
            val result = repository.activate(candidate, "\"SYN-${case.name.length}\"")
            failBeforeSwap = false
            assertEquals(case.name, ManifestActivation.Rejected(case.expected), result)
            assertSame(case.name, before, repository.active())

            val restarted = repository()
            val loaded = restarted.load()
            assertTrue(case.name, loaded is ManifestLoad.Active)
            assertArrayEquals(case.name, base.bytes(), (loaded as ManifestLoad.Active).active.bytes())
            assertEquals(case.name, "\"SYN-base\"", loaded.active.etag)
        }

        // Der verwaiste Kandidat liegt als Datei vor, ist aber nicht aktiv.
        val artifacts = File(store, "artifacts").listFiles()!!.filter { it.name.endsWith(".json") }
        assertEquals(2, artifacts.size)

        // Ein beschaedigter Zeiger ergibt keinen aktiven Stand und einen festen Fehler.
        File(store, "active.json").writeText("{SYN-kaputt")
        val broken = repository()
        assertEquals(ManifestLoad.Failed(ManifestStoreFailure.POINTER_CORRUPT), broken.load())
        assertNull(broken.active())
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

    private companion object {
        const val TAXI_ID = "SYN-taxi-1"
        const val KEY_ID = "SYN-key"
    }
}
