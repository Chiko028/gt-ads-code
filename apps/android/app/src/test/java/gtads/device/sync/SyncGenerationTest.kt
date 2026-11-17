package gtads.device.sync

import gtads.device.download.MediaDownloadResult
import gtads.device.download.MediaDownloader
import gtads.device.manifest.ManifestActivation
import gtads.device.manifest.ManifestFetchResult
import gtads.device.manifest.ManifestLoad
import gtads.device.manifest.ManifestStoreFailure
import java.io.File
import java.util.concurrent.CancellationException
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * CX-097: genau drei deterministische Tests fuer die Generationssperre.
 * Ausfuehrungsreihenfolge wird ausschliesslich durch synthetische Rueckrufe
 * gesteuert; es gibt keine Sleeps, kein Netz und keine neuen Bibliotheken.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncGenerationTest {
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
    fun olderRunCannotOverwriteNewerRunActivation() {
        val olderBytes = "SYN-generation-older".toByteArray()
        val newerBytes = "SYN-generation-newer-longer".toByteArray()
        val older = fixture.state(olderBytes)
        val newer = fixture.state(newerBytes)
        val repository = fixture.repository()

        var newerResult: SyncRunResult? = null
        val olderTransport = FakeSyncTransport(
            fixture.mediaDirectory,
            mapOf(fixture.sha256(olderBytes) to olderBytes),
        ).apply {
            candidate = older
            downloadOverride = { directory, media ->
                // Lauf B startet und endet vollstaendig, waehrend Lauf A noch
                // seine Medien uebernimmt. Keine Threads, keine Zeitsteuerung.
                if (newerResult == null) {
                    val newerTransport = FakeSyncTransport(
                        fixture.mediaDirectory,
                        mapOf(fixture.sha256(newerBytes) to newerBytes),
                    ).apply { candidate = newer }
                    newerResult = fixture.dependencies(newerTransport, repository = repository)
                        .coordinator()
                        .run()
                }
                val file = File(directory, "media-${media.sha256}.bin")
                file.writeBytes(olderBytes)
                MediaDownloadResult.Completed(file, media.sha256, olderBytes.size.toLong())
            }
        }

        val olderResult = fixture.dependencies(olderTransport, repository = repository).coordinator().run()

        assertEquals(SyncRunResult.Activated, newerResult)
        assertEquals(SyncRunResult.Superseded, olderResult)
        val active = repository.active()
        assertNotNull(active)
        assertArrayEquals("Der neuere Stand bleibt aktiv", newer.manifest.bytes(), active!!.bytes())
    }

    @Test
    fun cancelledOlderRunCleansOnlyItsOwnTemporaryFiles() {
        val activeBytes = "SYN-generation-active".toByteArray()
        val activeState = fixture.state(activeBytes)
        val activeMedia = fixture.mediaOf(activeState).single()
        fixture.writeMedia(activeMedia, activeBytes)
        val repository = fixture.repository()
        assertTrue(
            repository.activate(activeState.manifest, activeState.etag, repository.beginRun()!!)
                is ManifestActivation.Activated,
        )
        val activeTarget = MediaDownloader.targetFile(fixture.mediaDirectory, activeMedia)

        val newerBytes = "SYN-generation-running".toByteArray()
        val newerState = fixture.state(newerBytes)
        var newerDirectory: File? = null
        var ownDirectory: File? = null
        var cancelled = false

        val transport = FakeSyncTransport(fixture.mediaDirectory, emptyMap()).apply {
            candidate = newerState
            fetchOverride = {
                // Ein neuerer Lauf startet und legt seine eigene temporaere
                // Datei ab, waehrend der aeltere Lauf noch aktiv ist.
                val newerGeneration = repository.beginRun()!!
                newerDirectory = SyncCoordinator.runDirectoryFor(fixture.mediaDirectory, newerGeneration)
                    .apply { mkdirs() }
                File(newerDirectory, "media-running.part").writeBytes("SYN-newer-temp".toByteArray())
                ManifestFetchResult.Candidate(newerState)
            }
            downloadOverride = { directory, media ->
                ownDirectory = directory
                File(directory, "own-scratch.part").writeBytes("SYN-own-temp".toByteArray())
                val completed = File(directory, "media-${media.sha256}.bin")
                completed.writeBytes(newerBytes)
                cancelled = true
                MediaDownloadResult.Completed(completed, media.sha256, newerBytes.size.toLong())
            }
        }

        assertThrows(CancellationException::class.java) {
            fixture.dependencies(transport, repository = repository)
                .coordinator(cancelled = { cancelled })
                .run()
        }

        assertNotNull(ownDirectory)
        assertFalse("Nur das laufeigene Verzeichnis wird entfernt", ownDirectory!!.exists())
        val newerTemp = File(newerDirectory!!, "media-running.part")
        assertTrue("Temporaere Datei des neueren Laufs bleibt erhalten", newerTemp.isFile)
        assertEquals("SYN-newer-temp", newerTemp.readText())
        assertTrue("Aktives Medium bleibt erhalten", activeTarget.isFile)
        assertEquals(activeBytes.size.toLong(), activeTarget.length())
        assertArrayEquals(activeBytes, activeTarget.readBytes())
        assertArrayEquals(
            "Der aktive Stand bleibt unveraendert",
            activeState.manifest.bytes(),
            repository.active()!!.bytes(),
        )
    }

    @Test
    fun reopenedStoreRejectsStaleActivationAndKeepsLastActivatedState() {
        val oldBytes = "SYN-generation-stale".toByteArray()
        val newBytes = "SYN-generation-last-complete".toByteArray()
        val oldState = fixture.state(oldBytes)
        val newState = fixture.state(newBytes)
        fixture.writeMedia(fixture.mediaOf(oldState).single(), oldBytes)
        fixture.writeMedia(fixture.mediaOf(newState).single(), newBytes)

        val beforeRestart = fixture.repository()
        val staleGeneration = beforeRestart.beginRun()!!

        // Wiedereroeffnung desselben lokalen Speichers: die Generation wird
        // fortgeschrieben und der letzte vollstaendige Stand aktiviert.
        val reopened = fixture.repository()
        val currentGeneration = reopened.beginRun()!!
        assertTrue("Generation steigt ueber die Wiedereroeffnung hinweg", currentGeneration > staleGeneration)
        val activation = reopened.activate(newState.manifest, newState.etag, currentGeneration)
        assertTrue(activation is ManifestActivation.Activated)
        val activatedSha = reopened.active()!!.artifactSha256

        val stale = beforeRestart.activate(oldState.manifest, oldState.etag, staleGeneration)
        assertEquals(ManifestActivation.Rejected(ManifestStoreFailure.SUPERSEDED), stale)

        val reloaded = fixture.repository().load()
        assertTrue(reloaded is ManifestLoad.Active)
        val active = (reloaded as ManifestLoad.Active).active
        assertEquals(activatedSha, active.artifactSha256)
        assertArrayEquals(newState.manifest.bytes(), active.bytes())
    }
}
