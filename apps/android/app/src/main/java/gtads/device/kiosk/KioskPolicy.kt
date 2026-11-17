package gtads.device.kiosk

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Build

/** Minimale Device-Admin-Komponente fuer Lock-Task (R-907). Keine eigene Logik. */
class KioskAdminReceiver : DeviceAdminReceiver()

/**
 * Lokale Kiosk-Konfiguration. Standard ist aus; es gibt bewusst keinen Weg,
 * sie ueber Serverantworten oder Intent-Extras einzuschalten.
 */
interface KioskConfig {
    fun enabled(): Boolean
}

class SharedPreferencesKioskConfig(context: Context) : KioskConfig {
    private val preferences = context.applicationContext.getSharedPreferences("kiosk", Context.MODE_PRIVATE)
    override fun enabled(): Boolean = preferences.getBoolean(KEY_ENABLED, false)

    /** Nur lokal (Betreiberbetrieb), nie aus Netz oder Intent. */
    fun setEnabledLocally(value: Boolean) {
        preferences.edit().putBoolean(KEY_ENABLED, value).commit()
    }

    private companion object {
        const val KEY_ENABLED = "enabled"
    }
}

/** Testbare Plattformgrenze fuer DevicePolicyManager und Activity-Lock-Task. */
interface KioskPlatform {
    fun isDebuggable(): Boolean
    fun isDeviceOwner(): Boolean
    fun setLockTaskPackages(packages: Array<String>)
    fun minimizeLockTaskFeatures()
    fun isInLockTask(): Boolean
    fun startLockTask()
    fun stopLockTask()
}

/** Bereinigter Betriebsstatus ohne Geraete- oder Ausnahmedetails. */
enum class KioskStatus { DEBUG_LOCKED, DISABLED, NOT_DEVICE_OWNER, ACTIVE, PLATFORM_ERROR }

/**
 * Anwendungsseitiger Kiosk-Adapter (CX-091 / R-907/F-A02/S-04).
 *
 * Aktivierung nur wenn: kein Debug-Build UND lokale Konfiguration aktiv UND
 * Device Owner fuer das eigene Paket bestaetigt. Debug-Builds rufen niemals
 * sperrende Policy-Funktionen auf. Freigegeben wird ausschliesslich das eigene
 * Paket; startLockTask erst aus einer gestarteten Activity und hoechstens einmal
 * je von der App gestartetem Lock-Task. Keine Provisionierung, kein Reset,
 * keine globale Geraeteverwaltung, kein Fern-Bypass.
 */
class KioskPolicy(
    private val platform: KioskPlatform,
    private val config: KioskConfig,
    private val ownPackage: String,
) {
    private var startedByApp = false

    @Volatile
    var lastStatus: KioskStatus? = null
        private set

    /** Aus onStart der Activity; idempotent bei wiederholten Lebenszyklusrueckrufen. */
    @Synchronized
    fun onActivityStarted(): KioskStatus {
        val status = try {
            evaluate()
        } catch (_: Exception) {
            KioskStatus.PLATFORM_ERROR
        }
        lastStatus = status
        return status
    }

    private fun evaluate(): KioskStatus {
        if (platform.isDebuggable()) return KioskStatus.DEBUG_LOCKED
        if (!config.enabled()) {
            releaseOwnLockTask()
            return KioskStatus.DISABLED
        }
        if (!platform.isDeviceOwner()) {
            releaseOwnLockTask()
            return KioskStatus.NOT_DEVICE_OWNER
        }
        platform.setLockTaskPackages(arrayOf(ownPackage))
        platform.minimizeLockTaskFeatures()
        if (!platform.isInLockTask()) {
            platform.startLockTask()
            startedByApp = true
        }
        return KioskStatus.ACTIVE
    }

    /** Beendet ausschliesslich einen von der App selbst gestarteten Lock-Task. */
    private fun releaseOwnLockTask() {
        if (startedByApp && platform.isInLockTask()) {
            platform.stopLockTask()
        }
        startedByApp = false
    }
}

/** Produktiver Plattformadapter fuer eine gestartete Activity. */
class AndroidKioskPlatform(private val activity: Activity) : KioskPlatform {
    private val policyManager = activity.getSystemService(DevicePolicyManager::class.java)
    private val admin = ComponentName(activity, KioskAdminReceiver::class.java)

    override fun isDebuggable(): Boolean =
        (activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    override fun isDeviceOwner(): Boolean =
        policyManager?.isDeviceOwnerApp(activity.packageName) == true

    override fun setLockTaskPackages(packages: Array<String>) {
        policyManager?.setLockTaskPackages(admin, packages)
    }

    override fun minimizeLockTaskFeatures() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            policyManager?.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE)
        }
    }

    override fun isInLockTask(): Boolean {
        val manager = activity.getSystemService(ActivityManager::class.java) ?: return false
        return manager.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE
    }

    override fun startLockTask() = activity.startLockTask()

    override fun stopLockTask() = activity.stopLockTask()
}
