package gtads.device.sync

import android.content.Context
import android.os.SystemClock
import gtads.device.auth.DeviceAuthClient
import gtads.device.download.MediaDownloader
import gtads.device.identity.DeviceIdentity
import gtads.device.manifest.ManifestFetcher
import gtads.device.manifest.ManifestRepository
import gtads.device.registration.RegistrationBinding
import gtads.device.registration.RegistrationRepository

/**
 * Produktive Verdrahtung der vorhandenen R-902-Bausteine. CX-077 erfindet
 * weder Vertrauensschluessel noch Taxi-ID noch Download-Freigaben; diese
 * werden ueber [configure] aus den vorgelagerten Paketen geliefert.
 */
object SyncRuntime {
    @Volatile
    private var testDependencies: ((Context) -> SyncDependencies?)? = null

    @Volatile
    private var configurationProvider: ((Context, RegistrationBinding) -> SyncConfiguration?)? = null

    fun configure(provider: (Context, RegistrationBinding) -> SyncConfiguration?) {
        configurationProvider = provider
    }

    internal fun installForTest(provider: (Context) -> SyncDependencies?) {
        testDependencies = provider
    }

    internal fun resetForTest() {
        testDependencies = null
        configurationProvider = null
    }

    internal fun dependencies(context: Context): SyncDependencies? {
        testDependencies?.let { return it(context) }
        val binding = RegistrationRepository(context).readBinding() ?: return null
        val configuration = configurationProvider?.invoke(context, binding) ?: return null
        val auth = DeviceAuthClient(
            baseUrl = binding.baseUrl,
            deviceId = binding.deviceId,
            sign = { bytes -> DeviceIdentity().sign(bytes) },
        )
        val fetcher = ManifestFetcher(
            baseUrl = binding.baseUrl,
            auth = auth,
            trustedPublicKey = configuration.trustedManifestKey,
            expectedTaxiId = configuration.taxiId,
        )
        return SyncDependencies(
            repository = ManifestRepository(context, configuration.trustedManifestKey, configuration.taxiId),
            mediaDirectory = java.io.File(context.filesDir, MediaDownloader.MEDIA_DIRECTORY),
            fetchManifest = fetcher::fetch,
            grantUrl = configuration.grantUrl,
            downloadMedia = { directory, url, media ->
                MediaDownloader(directory, binding.baseUrl).download(url, media)
            },
            freeSpaceBytes = { context.filesDir.usableSpace },
            authState = SyncAuthGate(context),
            nowMs = SystemClock::elapsedRealtime,
        )
    }
}

