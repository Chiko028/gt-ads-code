package gtads.device.sync

import gtads.device.download.MediaDownloadResult
import gtads.device.download.MediaDownloader
import gtads.device.manifest.ManifestActivation
import gtads.device.manifest.ManifestFetchResult
import gtads.device.manifest.ManifestLoad
import gtads.device.manifest.ManifestRepository
import gtads.device.manifest.VerifiedManifestState
import gtads.device.manifest.VerifiedMedia
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncCoordinatorTest {
    private lateinit var fixture: SyncFixture

    @Before
    fun setUp() {
        fixture = SyncFixture()
    }

    @After
    fun tearDown() {
        fixture.cleanup()
    }

    @Test
    fun firstRunDownloadsRequiredMediaAndCompletesCandidateSecondRunDownloadsNothing() {
        val first = "SYN-media-first".toByteArray()
        val second = "SYN-media-second-longer".toByteArray()
        val candidate = fixture.state(first, second)
        val transport = FakeSyncTransport(
            fixture.mediaDirectory,
            mapOf(fixture.sha256(first) to first, fixture.sha256(second) to second),
        ).apply { this.candidate = candidate }
        val repository = fixture.repository()

        val result = fixture.dependencies(transport, repository = repository).coordinator().run()

        assertEquals(SyncRunResult.Activated, result)
        assertEquals(2, transport.downloadCalls)
        assertEquals(
            listOf(fixture.sha256(first), fixture.sha256(second)),
            transport.downloadedHashes,
        )
        assertNotNull(repository.active())
        fixture.mediaOf(candidate).forEach { media ->
            val target = MediaDownloader.targetFile(fixture.mediaDirectory, media)
            assertTrue(target.isFile)
            assertEquals(media.sizeBytes, target.length())
        }

        val secondRun = fixture.dependencies(transport, repository = repository).coordinator().run()

        assertEquals(SyncRunResult.Unchanged, secondRun)
        assertEquals("Ein unveraenderter Durchlauf laedt keine Medien erneut", 2, transport.downloadCalls)
    }

    @Test
    fun tableOfFailuresKeepsPreviousActiveState() {
        val previousBytes = "SYN-previous".toByteArray()
        val nextBytes = "SYN-next-longer".toByteArray()
        val cases = listOf(
            FailureCase(
                name = "Netzwerkabbruch",
                fetch = { ManifestFetchResult.Unavailable },
                expected = SyncRunResult.Transient,
            ),
            FailureCase(
                name = "Volle Ablage",
                freeSpace = 0L,
                expected = SyncRunResult.Failed(SyncFailure.STORAGE_FULL),
            ),
            FailureCase(
                name = "Authentifizierungsfehler",
                fetch = { ManifestFetchResult.AuthenticationRequired },
                expected = SyncRunResult.AuthenticationBlocked,
            ),
            FailureCase(
                name = "Netzwerkabbruch beim Download",
                download = { MediaDownloadResult.Retryable },
                expected = SyncRunResult.Transient,
            ),
        )

        for (case in cases) {
            val local = SyncFixture()
            try {
                val previous = local.state(previousBytes)
                val previousMedia = local.mediaOf(previous).single()
                local.writeMedia(previousMedia, previousBytes)
                val repository = local.repository()
                assertTrue(repository.activate(previous.manifest, previous.etag) is ManifestActivation.Activated)
                val previousSha = repository.active()!!.artifactSha256

                val next = local.state(nextBytes)
                val transport = FakeSyncTransport(
                    local.mediaDirectory,
                    mapOf(
                        previousMedia.sha256 to previousBytes,
                        local.sha256(nextBytes) to nextBytes,
                    ),
                ).apply {
                    candidate = next
                    fetchOverride = case.fetch
                    downloadOverride = case.download
                }
                val auth = InMemorySyncAuthState()
                val dependencies = local.dependencies(
                    transport = transport,
                    freeSpace = case.freeSpace,
                    auth = auth,
                    repository = repository,
                )

                val result = dependencies.coordinator().run()

                assertEquals(case.name, case.expected, result)
                val reloaded = repository.load()
                assertTrue("${case.name}: aktiver Stand fehlt", reloaded is ManifestLoad.Active)
                assertEquals(
                    "${case.name}: bisheriger Stand wurde ersetzt",
                    previousSha,
                    (reloaded as ManifestLoad.Active).active.artifactSha256,
                )
                if (case.expected == SyncRunResult.AuthenticationBlocked) {
                    assertTrue("${case.name}: Sperre nicht gesetzt", auth.isSuspended())
                    val fetches = transport.fetchCalls
                    val again = dependencies.coordinator().run()
                    assertEquals(SyncRunResult.AuthenticationBlocked, again)
                    assertEquals("Kein Abruf waehrend der Sperre", fetches, transport.fetchCalls)
                }
                if (case.expected == SyncRunResult.Failed(SyncFailure.STORAGE_FULL)) {
                    assertEquals("Volle Ablage darf nichts herunterladen", 0, transport.downloadCalls)
                }
            } finally {
                local.cleanup()
            }
        }
    }

    private class FailureCase(
        val name: String,
        val fetch: ((VerifiedManifestState?) -> ManifestFetchResult)? = null,
        val download: ((VerifiedMedia) -> MediaDownloadResult)? = null,
        val freeSpace: Long = 10L * 1024L * 1024L * 1024L,
        val expected: SyncRunResult,
    )
}

