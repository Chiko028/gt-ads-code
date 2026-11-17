package gtads.device.sync

import android.content.Context
import androidx.work.ListenableWorker
import androidx.work.WorkManager
import androidx.work.testing.TestListenableWorkerBuilder
import gtads.device.testsupport.initializeTestWorkManager
import gtads.device.download.MediaDownloader
import gtads.device.manifest.ManifestActivation
import gtads.device.manifest.ManifestLoad
import gtads.device.registration.REGISTRATION_FILE_NAME
import gtads.device.registration.RegistrationRepository
import gtads.device.registration.ServerConfiguration
import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncWorkerRobolectricTest {
    private lateinit var context: Context
    private lateinit var fixture: SyncFixture

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        fixture = SyncFixture()
        initializeTestWorkManager(RuntimeEnvironment.getApplication())
        SyncRuntime.resetForTest()
        deleteRegistration()
    }

    @After
    fun tearDown() {
        SyncRuntime.resetForTest()
        // echte WorkManager-Testinstanz wird je Test neu initialisiert
        fixture.cleanup()
        deleteRegistration()
    }

    @Test
    fun workerRunActivatesCandidateAndSecondUnchangedRunDoesNotDownloadMediaAgain() {
        val content = "SYN-worker-media".toByteArray()
        val candidate = fixture.state(content)
        val transport = FakeSyncTransport(
            fixture.mediaDirectory,
            mapOf(fixture.sha256(content) to content),
        ).apply { this.candidate = candidate }
        val repository = fixture.repository()
        SyncRuntime.installForTest {
            fixture.dependencies(transport, repository = repository)
        }

        val first = TestListenableWorkerBuilder.from(context, SyncWorker::class.java).build().doWork()
        assertTrue(first is ListenableWorker.Result.Success)
        assertEquals(1, transport.downloadCalls)
        assertNotNull(repository.active())
        fixture.mediaOf(candidate).forEach { media ->
            assertTrue(MediaDownloader.targetFile(fixture.mediaDirectory, media).isFile)
        }

        val second = TestListenableWorkerBuilder.from(context, SyncWorker::class.java).build().doWork()
        assertTrue(second is ListenableWorker.Result.Success)
        assertEquals("Zweiter Durchlauf darf keine Medien erneut laden", 1, transport.downloadCalls)
    }

    @Test
    fun workerKeepsPreviousStateWhenStorageIsFull() {
        val previousBytes = "SYN-worker-previous".toByteArray()
        val previous = fixture.state(previousBytes)
        val previousMedia = fixture.mediaOf(previous).single()
        fixture.writeMedia(previousMedia, previousBytes)
        val repository = fixture.repository()
        assertTrue(repository.activate(previous.manifest, previous.etag, repository.beginRun()!!) is ManifestActivation.Activated)
        val previousSha = repository.active()!!.artifactSha256

        val nextBytes = "SYN-worker-next".toByteArray()
        val transport = FakeSyncTransport(
            fixture.mediaDirectory,
            mapOf(fixture.sha256(nextBytes) to nextBytes),
        ).apply { candidate = fixture.state(nextBytes) }
        SyncRuntime.installForTest {
            fixture.dependencies(transport, freeSpace = 0L, repository = repository)
        }

        val result = TestListenableWorkerBuilder.from(context, SyncWorker::class.java).build().doWork()

        assertTrue(result is ListenableWorker.Result.Failure)
        val reloaded = repository.load()
        assertTrue(reloaded is ManifestLoad.Active)
        assertEquals(previousSha, (reloaded as ManifestLoad.Active).active.artifactSha256)
    }

    @Test
    fun repeatedStartRequestsKeepOneUniqueWorkChain() {
        repeat(3) { SyncScheduler.enqueueOneTime(context) }
        val oneTime = WorkManager.getInstance(context)
            .getWorkInfosForUniqueWork(SyncScheduler.UNIQUE_ONE_TIME).get()
        assertEquals("Genau eine einmalige Arbeitskette", 1, oneTime.size)

        val registration = RegistrationRepository(context)
        assertTrue(
            registration.writeRegistered(
                "SYN-device",
                ServerConfiguration(SYNC_BASE_URL, 1L),
            ),
        )
        repeat(2) { SyncScheduler.ensurePeriodic(context) }
        val periodic = WorkManager.getInstance(context)
            .getWorkInfosForUniqueWork(SyncScheduler.UNIQUE_PERIODIC).get()
        assertEquals("Genau eine periodische Arbeitskette", 1, periodic.size)
    }

    private fun deleteRegistration() {
        val file = File(context.noBackupFilesDir, REGISTRATION_FILE_NAME)
        file.delete()
        File(file.path + ".new").delete()
        File(file.path + ".bak").delete()
        context.getSharedPreferences("gt-ads-sync-auth", Context.MODE_PRIVATE)
            .edit().clear().commit()
    }
}

