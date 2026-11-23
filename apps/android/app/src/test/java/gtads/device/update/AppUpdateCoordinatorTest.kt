package gtads.device.update

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

private const val RELEASE = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
private const val PACKAGE = "gtads.device"

private class MemoryStore : AppUpdateStore {
    val failures = HashMap<String, Int>()
    val downloaded = HashMap<String, Long>()
    var started: StartedInstall? = null
    override fun failures(releaseId: String) = failures[releaseId] ?: 0
    override fun addFailure(releaseId: String) { failures[releaseId] = failures(releaseId) + 1 }
    override fun downloadedAtMs(releaseId: String) = downloaded[releaseId]
    override fun markDownloaded(releaseId: String, atMs: Long) { downloaded[releaseId] = atMs }
    override fun installStarted() = started
    override fun markInstallStarted(releaseId: String, versionCode: Long) { started = StartedInstall(releaseId, versionCode) }
    override fun clearInstallStarted() { started = null }
}

private class FakePorts(private val file: File) : AppUpdatePorts {
    var offer: OfferResult = OfferResult.None
    var installed = 2L
    var downloadOutcome: DownloadOutcome = DownloadOutcome.Completed(file)
    var archive: ArchiveInfo? = ArchiveInfo(PACKAGE, 3L, sameSigner = true)
    var quiet = true
    var installAccepted = true
    var now = 1_000_000L
    val reports = mutableListOf<Triple<String, String, String?>>()
    val installs = mutableListOf<AppUpdateOffer>()
    var downloads = 0
    var discardedAll = 0

    override fun fetchOffer() = offer
    override fun installedVersionCode() = installed
    override fun ownPackageName() = PACKAGE
    override fun download(offer: AppUpdateOffer): DownloadOutcome { downloads++; return downloadOutcome }
    override fun discardDownloads(keep: File?) { if (keep == null) discardedAll++ }
    override fun inspectArchive(file: File) = archive
    override fun isQuietMoment() = quiet
    override fun install(file: File, offer: AppUpdateOffer): Boolean { installs.add(offer); return installAccepted }
    override fun report(releaseId: String, status: String, detail: String?) { reports.add(Triple(releaseId, status, detail)) }
    override fun nowMs() = now
}

class AppUpdateCoordinatorTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var ports: FakePorts
    private lateinit var store: MemoryStore
    private lateinit var coordinator: AppUpdateCoordinator

    private fun offer(code: Long = 3L) = OfferResult.Offer(
        AppUpdateOffer(RELEASE, code, "0.$code.0", "a".repeat(64), 1234L, "https://srv.example/v1/device/app-downloads/$RELEASE?ticket=t"),
    )

    @Before
    fun setUp() {
        ports = FakePorts(temporary.newFile("update.bin"))
        store = MemoryStore()
        coordinator = AppUpdateCoordinator(ports, store)
    }

    @Test
    fun ohneZielOderBeiAktuellerVersionPassiertNichts() {
        assertEquals(AppUpdateRunResult.NoUpdate, coordinator.run())
        ports.offer = offer(code = 2L)
        assertEquals(AppUpdateRunResult.UpToDate, coordinator.run())
        ports.offer = offer(code = 1L)
        assertEquals(AppUpdateRunResult.UpToDate, coordinator.run())
        assertEquals(0, ports.downloads)
        assertTrue(ports.reports.isEmpty())
        assertEquals("alte Dateien werden verworfen", 3, ports.discardedAll)
    }

    @Test
    fun neuereVersionWirdGeladenGemeldetUndImRuhigenMomentInstalliert() {
        ports.offer = offer()
        assertEquals(AppUpdateRunResult.InstallStarted, coordinator.run())
        assertEquals(listOf(Triple(RELEASE, "downloaded", null)), ports.reports)
        assertEquals(1, ports.installs.size)
        assertEquals(StartedInstall(RELEASE, 3L), store.started)

        // Neuer Prozess nach dem Update: Version 3 laeuft -> "installed", danach nichts mehr zu tun.
        ports.installed = 3L
        assertEquals(AppUpdateRunResult.UpToDate, coordinator.run())
        assertEquals(Triple(RELEASE, "installed", null), ports.reports.last())
        assertNull(store.started)
        assertEquals("downloaded wird nur einmal gemeldet", 1, ports.reports.count { it.second == "downloaded" })
    }

    @Test
    fun waehrendDerWiedergabeWirdHoechstensZwoelfStundenGewartet() {
        ports.offer = offer()
        ports.quiet = false
        assertEquals(AppUpdateRunResult.Deferred, coordinator.run())
        ports.now += AppUpdateCoordinator.MAX_DEFER_MS - 1
        assertEquals(AppUpdateRunResult.Deferred, coordinator.run())
        assertTrue(ports.installs.isEmpty())
        ports.now += 1
        assertEquals(AppUpdateRunResult.InstallStarted, coordinator.run())
        assertEquals(1, ports.installs.size)
    }

    @Test
    fun falschesPaketFalscheVersionOderFremderSchluesselWerdenNieInstalliert() {
        ports.offer = offer()
        val cases = listOf(
            ArchiveInfo("fremd.paket", 3L, true) to "package_mismatch",
            ArchiveInfo(PACKAGE, 4L, true) to "version_mismatch",
            ArchiveInfo(PACKAGE, 3L, false) to "signer_mismatch",
            null to "archive_unreadable",
        )
        for ((archive, detail) in cases) {
            store.failures.clear()
            ports.archive = archive
            assertEquals(AppUpdateRunResult.Failed, coordinator.run())
            assertEquals(Triple(RELEASE, "failed", detail), ports.reports.last())
        }
        assertTrue(ports.installs.isEmpty())
    }

    @Test
    fun nachDreiFehlversuchenWirdDieVersionNichtMehrGeladen() {
        ports.offer = offer()
        ports.downloadOutcome = DownloadOutcome.Failed("download_hash")
        repeat(AppUpdateCoordinator.MAX_FAILURES) { assertEquals(AppUpdateRunResult.Failed, coordinator.run()) }
        assertEquals(AppUpdateRunResult.GaveUp, coordinator.run())
        assertEquals(AppUpdateCoordinator.MAX_FAILURES, ports.downloads)

        // Eine neue Version (andere ID) wird wieder versucht.
        ports.offer = OfferResult.Offer(
            AppUpdateOffer("1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", 4L, "0.4.0", "b".repeat(64), 10L, "https://x/y"),
        )
        ports.archive = ArchiveInfo(PACKAGE, 4L, true)
        ports.downloadOutcome = DownloadOutcome.Completed(temporary.newFile("v4.bin"))
        assertEquals(AppUpdateRunResult.InstallStarted, coordinator.run())
    }

    @Test
    fun voruebergehendeFehlerZaehlenNichtAlsFehlversuch() {
        ports.offer = offer()
        ports.downloadOutcome = DownloadOutcome.Retry
        repeat(5) { assertEquals(AppUpdateRunResult.Unavailable, coordinator.run()) }
        assertEquals(0, store.failures(RELEASE))
        ports.offer = OfferResult.Unavailable
        assertEquals(AppUpdateRunResult.Unavailable, coordinator.run())
        assertTrue(ports.reports.isEmpty())
    }

    @Test
    fun fehlgeschlageneInstallationWirdGemeldetUndGezaehlt() {
        ports.offer = offer()
        ports.installAccepted = false
        assertEquals(AppUpdateRunResult.Failed, coordinator.run())
        assertEquals(Triple(RELEASE, "failed", "install_start"), ports.reports.last())
        assertNull(store.started)

        ports.installAccepted = true
        assertEquals(AppUpdateRunResult.InstallStarted, coordinator.run())
        coordinator.onInstallResult(RELEASE, success = false, detail = "install_status_4")
        assertEquals(Triple(RELEASE, "failed", "install_status_4"), ports.reports.last())
        assertEquals(2, store.failures(RELEASE))
        assertNull(store.started)
        assertFalse(ports.reports.any { it.second == "installed" })
    }
}
