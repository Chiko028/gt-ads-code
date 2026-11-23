package gtads.device.boot

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import gtads.device.MainActivity
import gtads.device.registration.RegistrationRepository
import gtads.device.sync.SyncScheduler

/** Ergebnis eines Boot-Einstiegs (CX-090 / R-907). */
enum class BootOutcome {
    /** Geraet nicht registriert: nichts gestartet, Einrichtungseingaben bleiben unberuehrt. */
    NOT_REGISTERED,
    /** Erneute Zustellung im selben Prozess: keine zweite Arbeit, kein zweiter Start. */
    DUPLICATE,
    /** Plattform erlaubt den Vordergrundstart: normaler Startpfad (MainActivity) geoeffnet. */
    STARTED,
    /** Kein automatischer Start erlaubt: Benachrichtigung oeffnet den normalen Startpfad. */
    NOTIFIED,
    /** Weder Start noch Benachrichtigung erlaubt: der naechste manuelle App-Start bleibt der Weg. */
    WAITING_FOR_MANUAL_START,
}

/** Plattformgrenze des Boot-Einstiegs; in Tests ersetzbar (API-35-Entscheidungen ohne echtes Geraet). */
interface BootPlatform {
    fun isRegistered(): Boolean
    /** Vorhandene Synchronisierung eindeutig einplanen (SyncScheduler, eindeutige Arbeiten). */
    fun scheduleSync()
    /** Darf die App jetzt aus dem Hintergrund eine Activity starten (z. B. Device Owner, alte API)? */
    fun mayStartActivityFromBackground(): Boolean
    fun startActivity(intent: Intent)
    fun notificationsAllowed(): Boolean
    fun notify(intent: PendingIntent)
}

/**
 * Sicherer Boot-Einstieg: Der Receiver erledigt selbst keine Netzwerk- oder Playerarbeit,
 * plant nur die vorhandene Synchronisierung und delegiert die Wiedergabe an den normalen
 * Startpfad (MainActivity). Dort prueft der bestehende Ablauf erneut Registrierung,
 * persistierte Pause (CX-100) und lokale Kampagnenlaufzeit (CX-080/CX-098).
 * Kein Foreground-Service, keine Kiosk-Aktivierung (CX-091), kein Zugriff vor der Entsperrung
 * (Receiver ist nicht directBootAware).
 */
object BootStart {
    const val EXTRA_SOURCE = "gtads.device.extra.START_SOURCE"
    const val SOURCE_BOOT = "boot"
    const val CHANNEL_ID = "gtads-start"
    const val NOTIFICATION_ID = 907

    @Volatile
    private var handledInProcess = false

    internal fun resetForTest() {
        handledInProcess = false
    }

    /** Expliziter Intent auf den normalen Startpfad; eine bestehende Activity wird wiederverwendet. */
    fun launchIntent(context: Context): Intent =
        Intent(context.applicationContext, MainActivity::class.java)
            .setAction(Intent.ACTION_MAIN)
            .putExtra(EXTRA_SOURCE, SOURCE_BOOT)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)

    fun handle(context: Context, platform: BootPlatform): BootOutcome = synchronized(this) {
        if (!platform.isRegistered()) return BootOutcome.NOT_REGISTERED
        if (handledInProcess) return BootOutcome.DUPLICATE
        handledInProcess = true
        try {
            platform.scheduleSync()
        } catch (_: Exception) {
            // Ohne Planung bleibt der normale Start funktionsfaehig (MainActivity plant erneut).
        }
        val intent = launchIntent(context)
        if (platform.mayStartActivityFromBackground()) {
            try {
                platform.startActivity(intent)
                return BootOutcome.STARTED
            } catch (_: Exception) {
                // Plattform hat den Start trotz Voraussetzung verweigert: Benachrichtigungsweg.
            }
        }
        if (!platform.notificationsAllowed()) return BootOutcome.WAITING_FOR_MANUAL_START
        return try {
            val pending = PendingIntent.getActivity(
                context.applicationContext,
                NOTIFICATION_ID,
                intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            platform.notify(pending)
            BootOutcome.NOTIFIED
        } catch (_: Exception) {
            BootOutcome.WAITING_FOR_MANUAL_START
        }
    }
}

/** Produktive Plattform: Registrierung, SyncScheduler, Device-Owner-Pruefung und Benachrichtigung. */
class AndroidBootPlatform(context: Context) : BootPlatform {
    private val app = context.applicationContext

    override fun isRegistered(): Boolean = try {
        RegistrationRepository(app).readBinding() != null
    } catch (_: Exception) {
        false
    }

    override fun scheduleSync() {
        SyncScheduler.enqueueOneTime(app)
        SyncScheduler.ensurePeriodic(app)
    }

    /** Hintergrundstarts sind ab Android 10 nur in Ausnahmefaellen erlaubt (u. a. Device Owner). */
    override fun mayStartActivityFromBackground(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return true
        val dpm = app.getSystemService(DevicePolicyManager::class.java) ?: return false
        return dpm.isDeviceOwnerApp(app.packageName)
    }

    override fun startActivity(intent: Intent) {
        app.startActivity(intent)
    }

    override fun notificationsAllowed(): Boolean {
        val manager = app.getSystemService(NotificationManager::class.java) ?: return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        return manager.areNotificationsEnabled()
    }

    override fun notify(intent: PendingIntent) {
        val manager = app.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(BootStart.CHANNEL_ID, "GT Ads Start", NotificationManager.IMPORTANCE_DEFAULT),
        )
        val notification = Notification.Builder(app, BootStart.CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("GT Ads")
            .setContentText("Tippen, um die Wiedergabe zu starten")
            .setContentIntent(intent)
            .setAutoCancel(true)
            .build()
        manager.notify(BootStart.NOTIFICATION_ID, notification)
    }
}

/** Manifest-Receiver fuer BOOT_COMPLETED; nur nach Entsperrung (nicht directBootAware). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        try {
            BootStart.handle(context, platformFactory(context))
        } catch (_: Exception) {
            // Boot darf nie abstuerzen; der manuelle Start bleibt moeglich.
        }
    }

    companion object {
        @Volatile
        internal var platformFactory: (Context) -> BootPlatform = { AndroidBootPlatform(it) }
    }
}
