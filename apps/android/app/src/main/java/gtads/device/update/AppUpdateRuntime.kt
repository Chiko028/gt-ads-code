package gtads.device.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import gtads.device.auth.DeviceAuthClient
import gtads.device.auth.DeviceAuthResult
import gtads.device.auth.DeviceHttp
import gtads.device.auth.DeviceHttpResult
import gtads.device.boot.AndroidBootPlatform
import gtads.device.boot.BootStart
import gtads.device.config.DeviceRuntimeSetup
import gtads.device.download.MediaDownloadResult
import gtads.device.download.MediaDownloader
import gtads.device.manifest.VerifiedMedia
import gtads.device.registration.RegistrationBinding
import gtads.device.registration.RegistrationRepository
import gtads.device.registration.normalizeServerBaseUrl
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.CancellationException
import java.util.concurrent.TimeUnit
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener

/** Server-Grenze: Ziel abfragen und Ergebnis melden (Bearer aus der Geraeteanmeldung). */
class AppUpdateClient(
    private val baseUrl: String,
    private val auth: DeviceAuthClient,
    openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
) {
    private val http = DeviceHttp(baseUrl, openConnection, TIMEOUT_MS, TIMEOUT_MS)

    fun fetchOffer(): OfferResult {
        val token = (auth.obtainToken() as? DeviceAuthResult.Token)?.accessToken ?: return OfferResult.Unavailable
        val response = http.call("GET", OFFER_PATH, null, token, null, MAX_BYTES) as? DeviceHttpResult.Response
            ?: return OfferResult.Unavailable
        if (response.status != 200) return OfferResult.Unavailable
        return parseOffer(response.body, baseUrl)
    }

    fun report(releaseId: String, status: String, detail: String?) {
        val token = (auth.obtainToken() as? DeviceAuthResult.Token)?.accessToken ?: return
        val body = JSONObject().put("release_id", releaseId).put("status", status)
        if (detail != null) body.put("detail", detail)
        http.call("POST", REPORT_PATH, body.toString().toByteArray(Charsets.UTF_8), token, null, MAX_BYTES)
    }

    companion object {
        const val TIMEOUT_MS = 15_000
        const val MAX_BYTES = 16_384
        const val OFFER_PATH = "/v1/device/app-update"
        const val REPORT_PATH = "/v1/device/app-update/report"
        const val DOWNLOAD_PREFIX = "/v1/device/app-downloads/"
        private val UUID = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
        private val SHA256 = Regex("[0-9a-f]{64}")

        /** Strenge Pruefung der Serverantwort; jede Abweichung ergibt Unavailable. */
        internal fun parseOffer(body: ByteArray, baseUrl: String): OfferResult {
            val root = try {
                JSONTokener(String(body, Charsets.UTF_8)).nextValue() as? JSONObject
            } catch (_: JSONException) {
                null
            } ?: return OfferResult.Unavailable
            val update = root.opt("update")
            if (update == null || update == JSONObject.NULL) return OfferResult.None
            if (update !is JSONObject) return OfferResult.Unavailable
            val releaseId = update.opt("release_id") as? String ?: return OfferResult.Unavailable
            val versionCode = (update.opt("version_code") as? Number)?.toLong() ?: return OfferResult.Unavailable
            val versionName = update.opt("version_name") as? String ?: return OfferResult.Unavailable
            val sha256 = update.opt("sha256") as? String ?: return OfferResult.Unavailable
            val sizeBytes = (update.opt("size_bytes") as? Number)?.toLong() ?: return OfferResult.Unavailable
            val path = update.opt("download_path") as? String ?: return OfferResult.Unavailable
            if (!UUID.matches(releaseId) || versionCode <= 0L || versionName.isBlank() || versionName.length > 64 ||
                !SHA256.matches(sha256) || sizeBytes <= 0L || sizeBytes > MediaDownloader.MAX_MEDIA_BYTES ||
                !path.startsWith("$DOWNLOAD_PREFIX$releaseId?ticket=")
            ) {
                return OfferResult.Unavailable
            }
            val base = normalizeServerBaseUrl(baseUrl) ?: return OfferResult.Unavailable
            return OfferResult.Offer(
                AppUpdateOffer(releaseId, versionCode, versionName, sha256, sizeBytes, base.trimEnd('/') + path),
            )
        }
    }
}

/** Lokaler Zustand in SharedPreferences (nur IDs, Zaehler und Zeitpunkte). */
class SharedPrefsAppUpdateStore(context: Context) : AppUpdateStore {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    override fun failures(releaseId: String): Int = prefs.getInt(FAILURES + releaseId, 0)

    override fun addFailure(releaseId: String) {
        prefs.edit().putInt(FAILURES + releaseId, failures(releaseId) + 1).commit()
    }

    override fun downloadedAtMs(releaseId: String): Long? =
        prefs.getLong(DOWNLOADED + releaseId, -1L).takeIf { it >= 0L }

    override fun markDownloaded(releaseId: String, atMs: Long) {
        prefs.edit().putLong(DOWNLOADED + releaseId, atMs).commit()
    }

    override fun installStarted(): StartedInstall? {
        val releaseId = prefs.getString(STARTED_RELEASE, null) ?: return null
        val code = prefs.getLong(STARTED_CODE, -1L).takeIf { it > 0L } ?: return null
        return StartedInstall(releaseId, code)
    }

    override fun markInstallStarted(releaseId: String, versionCode: Long) {
        prefs.edit().putString(STARTED_RELEASE, releaseId).putLong(STARTED_CODE, versionCode).commit()
    }

    override fun clearInstallStarted() {
        prefs.edit().remove(STARTED_RELEASE).remove(STARTED_CODE).commit()
    }

    private companion object {
        const val PREFS = "gtads-app-update"
        const val FAILURES = "failures:"
        const val DOWNLOADED = "downloaded:"
        const val STARTED_RELEASE = "started_release"
        const val STARTED_CODE = "started_code"
    }
}

/** Produktive Plattform: Download, Archivpruefung, Ladezustand und PackageInstaller. */
class AndroidAppUpdatePorts(
    context: Context,
    private val binding: RegistrationBinding,
    private val client: AppUpdateClient,
    private val openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
) : AppUpdatePorts {
    private val app = context.applicationContext
    private val directory = File(app.filesDir, UPDATE_DIRECTORY)

    override fun fetchOffer(): OfferResult = try {
        client.fetchOffer()
    } catch (_: Exception) {
        OfferResult.Unavailable
    }

    override fun installedVersionCode(): Long = installedVersionCode(app)

    override fun ownPackageName(): String = app.packageName

    override fun download(offer: AppUpdateOffer): DownloadOutcome {
        val media = VerifiedMedia.of(offer.releaseId, offer.sha256, offer.sizeBytes)
            ?: return DownloadOutcome.Failed("offer_invalid")
        val downloader = MediaDownloader(
            directory,
            binding.baseUrl,
            openConnection,
            AppUpdateClient.DOWNLOAD_PREFIX,
        ) { false }
        return when (val result = downloader.download(offer.downloadUrl, media)) {
            is MediaDownloadResult.Completed -> DownloadOutcome.Completed(result.file)
            is MediaDownloadResult.IntegrityFailure -> DownloadOutcome.Failed("download_" + result.code.name.lowercase())
            MediaDownloadResult.InvalidInput -> DownloadOutcome.Failed("download_invalid")
            else -> DownloadOutcome.Retry
        }
    }

    override fun discardDownloads(keep: File?) {
        directory.listFiles()?.forEach { if (keep == null || it.canonicalPath != keep.canonicalPath) it.delete() }
    }

    override fun inspectArchive(file: File): ArchiveInfo? = try {
        val pm = app.packageManager
        val archive = pm.getPackageArchiveInfo(file.path, signatureFlags()) ?: return null
        val own = pm.getPackageInfo(app.packageName, signatureFlags())
        val archiveSigners = signerDigests(archive)
        ArchiveInfo(
            packageName = archive.packageName ?: "",
            versionCode = versionCodeOf(archive),
            sameSigner = archiveSigners.isNotEmpty() && archiveSigners == signerDigests(own),
        )
    } catch (_: Exception) {
        null
    }

    override fun isQuietMoment(): Boolean = try {
        app.getSystemService(android.os.BatteryManager::class.java)?.isCharging == false
    } catch (_: Exception) {
        false
    }

    override fun install(file: File, offer: AppUpdateOffer): Boolean = try {
        val installer = app.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(app.packageName)
            setSize(file.length())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
        }
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            file.inputStream().use { input ->
                session.openWrite("base.apk", 0, file.length()).use { output ->
                    input.copyTo(output)
                    session.fsync(output)
                }
            }
            val intent = Intent(app, AppUpdateInstallReceiver::class.java)
                .setAction(AppUpdateInstallReceiver.ACTION)
                .putExtra(AppUpdateInstallReceiver.EXTRA_RELEASE_ID, offer.releaseId)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
            val pending = PendingIntent.getBroadcast(app, INSTALL_REQUEST_CODE, intent, flags)
            session.commit(pending.intentSender)
        }
        true
    } catch (_: Exception) {
        false
    }

    override fun report(releaseId: String, status: String, detail: String?) {
        try {
            client.report(releaseId, status, detail)
        } catch (_: Exception) {
            // Rueckmeldung ist best effort; der Heartbeat meldet die Version ohnehin.
        }
    }

    override fun nowMs(): Long = System.currentTimeMillis()

    companion object {
        const val UPDATE_DIRECTORY = "app-updates"
        private const val INSTALL_REQUEST_CODE = 4711

        fun installedVersionCode(context: Context): Long = try {
            versionCodeOf(context.packageManager.getPackageInfo(context.packageName, 0))
        } catch (_: Exception) {
            0L
        }

        @Suppress("DEPRECATION")
        private fun versionCodeOf(info: PackageInfo): Long =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()

        @Suppress("DEPRECATION")
        private fun signatureFlags(): Int =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES

        @Suppress("DEPRECATION")
        private fun signerDigests(info: PackageInfo): Set<String> {
            val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                info.signingInfo?.apkContentsSigners
            } else {
                info.signatures
            } ?: return emptySet()
            return signatures.map { signature ->
                MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())
                    .joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
            }.toSet()
        }
    }
}

/** Produktive Verdrahtung je Lauf; null ohne Registrierung. */
object AppUpdateRuntime {
    @Volatile
    internal var testCoordinator: ((Context) -> AppUpdateCoordinator?)? = null

    fun coordinator(context: Context): AppUpdateCoordinator? {
        testCoordinator?.let { return it(context) }
        val binding = RegistrationRepository(context).readBinding() ?: return null
        val auth = DeviceRuntimeSetup.authFactory(binding)
        val client = AppUpdateClient(binding.baseUrl, auth, DeviceRuntimeSetup.openConnection)
        val ports = AndroidAppUpdatePorts(context, binding, client, DeviceRuntimeSetup.openConnection)
        return AppUpdateCoordinator(ports, SharedPrefsAppUpdateStore(context))
    }
}

/**
 * Seltene Pruefung: kurz nach jedem Start (App, Neustart, Update) und danach
 * alle [PERIOD_HOURS] Stunden mit Netz. Kein 15-Minuten-Takt.
 */
object AppUpdateScheduler {
    const val UNIQUE_PERIODIC = "gt-ads-app-update-periodic"
    const val UNIQUE_SOON = "gt-ads-app-update-soon"
    const val PERIOD_HOURS = 6L
    const val START_DELAY_MINUTES = 2L
    const val RETRY_DELAY_MINUTES = 30L

    fun ensure(context: Context) {
        val app = context.applicationContext
        if (RegistrationRepository(app).readBinding() == null) return
        val request = PeriodicWorkRequestBuilder<AppUpdateWorker>(PERIOD_HOURS, TimeUnit.HOURS)
            .setConstraints(networkConstraint())
            .build()
        try {
            WorkManager.getInstance(app).enqueueUniquePeriodicWork(UNIQUE_PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
        } catch (_: IllegalStateException) {
            // WorkManager in diesem Prozess nicht verfuegbar.
        }
        enqueueSoon(app, START_DELAY_MINUTES, ExistingWorkPolicy.KEEP)
    }

    fun enqueueSoon(context: Context, delayMinutes: Long, policy: ExistingWorkPolicy) {
        val request = OneTimeWorkRequestBuilder<AppUpdateWorker>()
            .setInitialDelay(delayMinutes, TimeUnit.MINUTES)
            .setConstraints(networkConstraint())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 5, TimeUnit.MINUTES)
            .build()
        try {
            WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(UNIQUE_SOON, policy, request)
        } catch (_: IllegalStateException) {
            // WorkManager in diesem Prozess nicht verfuegbar.
        }
    }

    private fun networkConstraint() = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
}

class AppUpdateWorker(appContext: Context, params: WorkerParameters) : Worker(appContext, params) {
    override fun doWork(): Result {
        val coordinator = try {
            AppUpdateRuntime.coordinator(applicationContext)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        } ?: return Result.success()
        val result = try {
            coordinator.run()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            AppUpdateRunResult.Unavailable
        }
        // Wartet auf einen ruhigen Moment: in 30 Minuten erneut, sonst regulaer alle 6 h.
        if (result == AppUpdateRunResult.Deferred) {
            AppUpdateScheduler.enqueueSoon(applicationContext, AppUpdateScheduler.RETRY_DELAY_MINUTES, ExistingWorkPolicy.REPLACE)
        }
        return Result.success()
    }
}

/** Ergebnis der PackageInstaller-Sitzung. */
class AppUpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val releaseId = intent.getStringExtra(EXTRA_RELEASE_ID) ?: return
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            // Nur ohne Device Owner (z. B. Testhandy): Android fragt nach. Auf den
            // eingerichteten Tablets laeuft die Installation still.
            @Suppress("DEPRECATION")
            val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
            try {
                context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (_: Exception) {
                // Ohne Vordergrund nicht moeglich; der naechste Lauf versucht es erneut.
            }
            return
        }
        val success = status == PackageInstaller.STATUS_SUCCESS
        val pending = goAsync()
        Thread {
            try {
                AppUpdateRuntime.coordinator(context)?.onInstallResult(releaseId, success, if (success) null else "install_status_$status")
            } catch (_: Exception) {
                // Nie abstuerzen.
            } finally {
                pending.finish()
            }
        }.start()
    }

    companion object {
        const val ACTION = "gtads.device.update.INSTALL_RESULT"
        const val EXTRA_RELEASE_ID = "gtads.device.update.RELEASE_ID"
    }
}

/**
 * Nach einem Update startet Android die App nicht von selbst. Dieser Empfaenger
 * oeffnet den normalen Startpfad (wie nach einem Neustart) und meldet die
 * Installation kurz darauf an den Server.
 */
class AppUpdatedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        try {
            AppUpdateScheduler.enqueueSoon(context, 0L, ExistingWorkPolicy.REPLACE)
            BootStart.handle(context, AndroidBootPlatform(context))
        } catch (_: Exception) {
            // Nie abstuerzen; der naechste Neustart oeffnet die App.
        }
    }
}

/** Sha-256 einer Datei in Hex (fuer Tests und Diagnose). */
internal fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
