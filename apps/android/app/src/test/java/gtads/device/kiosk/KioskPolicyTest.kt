package gtads.device.kiosk

import android.content.ComponentName
import android.content.pm.PackageManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** CX-091: produktive Kiosk-Policy mit injiziertem Plattformadapter. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class KioskPolicyTest {
    private val own = "gtads.device"

    private class FakePlatform(
        var debuggable: Boolean = false,
        var owner: Boolean = true,
    ) : KioskPlatform {
        val calls = mutableListOf<String>()
        var inLockTask = false
        var failOnStart = false
        override fun isDebuggable() = debuggable
        override fun isDeviceOwner() = owner
        override fun setLockTaskPackages(packages: Array<String>) {
            calls += "packages:" + packages.joinToString(",")
        }
        override fun minimizeLockTaskFeatures() {
            calls += "features"
        }
        override fun isInLockTask() = inLockTask
        override fun startLockTask() {
            calls += "start"
            if (failOnStart) throw SecurityException("SYN")
            inLockTask = true
        }
        override fun stopLockTask() {
            calls += "stop"
            inLockTask = false
        }
    }

    private class Config(var on: Boolean) : KioskConfig {
        override fun enabled() = on
    }

    @Test
    fun debugBuildNeverCallsLockingFunctionsEvenWithConfigAndDeviceOwner() {
        val platform = FakePlatform(debuggable = true, owner = true)
        val policy = KioskPolicy(platform, Config(true), own)
        repeat(3) { assertEquals(KioskStatus.DEBUG_LOCKED, policy.onActivityStarted()) }
        assertEquals(emptyList<String>(), platform.calls)

        // Die Testumgebung selbst ist ein Debug-Build: der produktive Adapter erkennt das.
        val app = RuntimeEnvironment.getApplication()
        val debuggable = (app.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
        assertTrue(debuggable)
    }

    @Test
    fun releaseWithoutConfigOrDeviceOwnerStartsNoLockTaskAndReportsCleanStatus() {
        val noConfig = FakePlatform()
        assertEquals(KioskStatus.DISABLED, KioskPolicy(noConfig, Config(false), own).onActivityStarted())
        assertEquals(emptyList<String>(), noConfig.calls)

        val noOwner = FakePlatform(owner = false)
        assertEquals(KioskStatus.NOT_DEVICE_OWNER, KioskPolicy(noOwner, Config(true), own).onActivityStarted())
        assertEquals(emptyList<String>(), noOwner.calls)

        // Standard der produktiven Konfiguration ist aus.
        assertEquals(false, SharedPreferencesKioskConfig(RuntimeEnvironment.getApplication()).enabled())
    }

    @Test
    fun releaseWithConfigAndDeviceOwnerAllowsOnlyOwnPackageAndStartsLockTaskOnce() {
        val platform = FakePlatform()
        val policy = KioskPolicy(platform, Config(true), own)
        repeat(3) { assertEquals(KioskStatus.ACTIVE, policy.onActivityStarted()) }
        assertEquals(1, platform.calls.count { it == "start" })
        assertTrue(platform.calls.filter { it.startsWith("packages:") }.all { it == "packages:$own" })
        assertTrue(platform.calls.contains("features"))

        // Manifest deklariert genau die Device-Admin-Komponente mit Bind-Berechtigung.
        val app = RuntimeEnvironment.getApplication()
        val info = app.packageManager.getReceiverInfo(
            ComponentName(app, KioskAdminReceiver::class.java),
            PackageManager.GET_META_DATA,
        )
        assertEquals("android.permission.BIND_DEVICE_ADMIN", info.permission)
    }

    @Test
    fun revokedPrerequisitesRestartAndPlatformErrorsDoNotCrashOrLoop() {
        val platform = FakePlatform()
        val config = Config(true)
        val policy = KioskPolicy(platform, config, own)
        policy.onActivityStarted()
        assertTrue(platform.inLockTask)

        // Konfiguration ausgeschaltet: der von der App gestartete Lock-Task endet.
        config.on = false
        assertEquals(KioskStatus.DISABLED, policy.onActivityStarted())
        assertEquals(1, platform.calls.count { it == "stop" })
        policy.onActivityStarted()
        assertEquals(1, platform.calls.count { it == "stop" })

        // Device Owner widerrufen nach erneutem Einschalten: kein Start.
        config.on = true
        platform.owner = false
        assertEquals(KioskStatus.NOT_DEVICE_OWNER, policy.onActivityStarted())
        assertEquals(1, platform.calls.count { it == "start" })

        // Plattformausnahme: bereinigter Status, kein Absturz, keine Startschleife.
        platform.owner = true
        platform.failOnStart = true
        repeat(3) { assertEquals(KioskStatus.PLATFORM_ERROR, policy.onActivityStarted()) }
        assertEquals(4, platform.calls.count { it == "start" })

        // Fremd gestarteter Lock-Task wird nie von der App beendet.
        val foreign = FakePlatform().apply { inLockTask = true }
        val foreignPolicy = KioskPolicy(foreign, Config(false), own)
        foreignPolicy.onActivityStarted()
        assertEquals(0, foreign.calls.count { it == "stop" })
    }
}
