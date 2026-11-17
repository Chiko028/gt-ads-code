package gtads.device.boot

import android.Manifest
import android.app.Application
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import gtads.device.MainActivity
import gtads.device.registration.REGISTRATION_FILE_NAME
import gtads.device.registration.RegistrationRepository
import java.io.File
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** Aufzeichnende Plattform: Plattformentscheidungen (auch API 35) werden injiziert, nicht auf echtem Geraet nachgewiesen. */
private class FakePlatform(
    var registered: Boolean = true,
    var mayStart: Boolean = true,
    var notificationsAllowed: Boolean = true,
    var startThrows: Boolean = false,
) : BootPlatform {
    var syncCalls = 0
    val started = mutableListOf<Intent>()
    val notified = mutableListOf<PendingIntent>()

    override fun isRegistered() = registered
    override fun scheduleSync() { syncCalls++ }
    override fun mayStartActivityFromBackground() = mayStart
    override fun startActivity(intent: Intent) {
        if (startThrows) throw SecurityException("Hintergrundstart verweigert (synthetisch)")
        started.add(intent)
    }
    override fun notificationsAllowed() = notificationsAllowed
    override fun notify(intent: PendingIntent) { notified.add(intent) }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BootStartTest {
    private lateinit var app: Application

    @Before
    fun setUp() {
        app = RuntimeEnvironment.getApplication()
        BootStart.resetForTest()
        deleteRegistration()
    }

    @After
    fun tearDown() {
        BootStart.resetForTest()
        BootReceiver.platformFactory = { AndroidBootPlatform(it) }
        deleteRegistration()
    }

    private fun deleteRegistration() {
        val file = File(app.noBackupFilesDir, REGISTRATION_FILE_NAME)
        file.delete()
        File(file.path + ".new").delete()
        File(file.path + ".bak").delete()
    }

    private fun boot(platform: BootPlatform) {
        BootReceiver.platformFactory = { platform }
        BootReceiver().onReceive(app, Intent(Intent.ACTION_BOOT_COMPLETED))
    }

    private fun assertNormalStartPath(intent: Intent) {
        assertEquals(MainActivity::class.java.name, intent.component?.className)
        assertEquals(BootStart.SOURCE_BOOT, intent.getStringExtra(BootStart.EXTRA_SOURCE))
        assertTrue(intent.flags and Intent.FLAG_ACTIVITY_SINGLE_TOP != 0)
    }

    @Test
    fun registriertesGeraetPlantGenauEinmalUndOeffnetDenStartpfadAuchBeiDoppelterZustellung() {
        // Manifest-Anbindung: Receiver fuer BOOT_COMPLETED und die Boot-Berechtigung sind deklariert.
        val receivers = app.packageManager.queryBroadcastReceivers(Intent(Intent.ACTION_BOOT_COMPLETED).setPackage(app.packageName), 0)
        assertTrue(receivers.any { it.activityInfo.name == BootReceiver::class.java.name })
        val info = app.packageManager.getPackageInfo(app.packageName, PackageManager.GET_PERMISSIONS)
        assertTrue(info.requestedPermissions!!.contains(Manifest.permission.RECEIVE_BOOT_COMPLETED))

        val platform = FakePlatform()
        boot(platform)
        boot(platform) // doppelte Zustellung
        assertEquals(1, platform.syncCalls)
        assertEquals(1, platform.started.size)
        assertNormalStartPath(platform.started.single())
        assertTrue(platform.notified.isEmpty())
        // Andere Broadcasts loesen nichts aus.
        BootStart.resetForTest()
        BootReceiver.platformFactory = { platform }
        BootReceiver().onReceive(app, Intent(Intent.ACTION_TIME_CHANGED))
        assertEquals(1, platform.syncCalls)
    }

    @Test
    fun unregistriertesGeraetStartetNichtsUndBehaeltEinrichtungseingaben() {
        val repository = RegistrationRepository(File(app.noBackupFilesDir, REGISTRATION_FILE_NAME))
        assertTrue(repository.writeMarker("https://gtads.example.invalid"))
        val file = File(app.noBackupFilesDir, REGISTRATION_FILE_NAME)
        val before = file.readBytes()

        val platform = FakePlatform(registered = false)
        boot(platform)
        assertEquals(0, platform.syncCalls)
        assertTrue(platform.started.isEmpty())
        assertTrue(platform.notified.isEmpty())
        assertArrayEquals("Einrichtungseingaben unveraendert", before, file.readBytes())

        // Produktive Plattform ohne Registrierung: ebenfalls nichts.
        assertFalse(AndroidBootPlatform(app).isRegistered())
        assertEquals(BootOutcome.NOT_REGISTERED, BootStart.handle(app, AndroidBootPlatform(app)))
        assertArrayEquals(before, file.readBytes())
    }

    @Test
    fun verweigerterAutostartFuehrtOhneAbsturzUndSchleifeZurBenachrichtigung() {
        // API-35-typisch: kein Hintergrundstart erlaubt -> Benachrichtigung mit unveraenderlichem, explizitem Intent.
        val refused = FakePlatform(mayStart = false)
        assertEquals(BootOutcome.NOTIFIED, BootStart.handle(app, refused))
        assertTrue(refused.started.isEmpty())
        val pending = refused.notified.single()
        assertTrue(pending.isImmutable)
        assertNormalStartPath(shadowOf(pending).savedIntent)
        assertEquals(1, refused.syncCalls)

        // Start trotz Voraussetzung verweigert -> derselbe Benachrichtigungsweg, kein Wiederholen.
        BootStart.resetForTest()
        val throwing = FakePlatform(startThrows = true)
        assertEquals(BootOutcome.NOTIFIED, BootStart.handle(app, throwing))
        assertTrue(throwing.started.isEmpty())
        assertEquals(1, throwing.notified.size)

        // Ohne Benachrichtigungsrecht: kein Absturz, keine Umgehung; manueller Start bleibt.
        BootStart.resetForTest()
        val silent = FakePlatform(mayStart = false, notificationsAllowed = false)
        assertEquals(BootOutcome.WAITING_FOR_MANUAL_START, BootStart.handle(app, silent))
        assertTrue(silent.notified.isEmpty() && silent.started.isEmpty())

        // Produktive Plattform (Robolectric SDK 34, kein Device Owner): kein Hintergrundstart;
        // Benachrichtigung nur mit erteilter POST_NOTIFICATIONS-Berechtigung.
        val production = AndroidBootPlatform(app)
        assertFalse(production.mayStartActivityFromBackground())
        shadowOf(app).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
        assertFalse(production.notificationsAllowed())
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        assertTrue(production.notificationsAllowed())
        production.notify(pending)
        val manager = app.getSystemService(NotificationManager::class.java)
        val posted = shadowOf(manager).allNotifications.single()
        assertEquals(pending, posted.contentIntent)
        assertNull(shadowOf(app).nextStartedActivity)
    }
}
