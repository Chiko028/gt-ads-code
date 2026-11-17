package gtads.device.playback

import android.app.Activity
import android.content.Context
import android.view.View
import gtads.device.manifest.ActiveManifest
import gtads.device.manifest.ManifestLoad
import gtads.device.sync.SyncRuntime

/**
 * Produktive Verdrahtung der sichtbaren Offline-Wiedergabe (CX-082).
 *
 * Es werden weder Vertrauensschluessel noch Taxi-ID noch Registrierungsdaten
 * erfunden: [PlaybackSnapshotReader] fragt die bestehende CX-077-Verdrahtung
 * ([SyncRuntime.dependencies]) und liefert nur dann einen lokalen Stand, wenn
 * eine registrierte Bindung und eine Konfiguration vorhanden sind. Fehlt eines
 * davon, bleibt die Registrierungsoberflaeche sichtbar (IDLE).
 *
 * Die Medienpruefung erfolgt ausschliesslich lokal ueber
 * [gtads.device.manifest.ManifestRepository.load]; es gibt keinen Netzaufruf.
 */
object PlaybackRuntime {
    private class Overrides(
        val controllerFactory: (Context, (PlaybackUiState) -> Unit) -> PlaybackController,
        val surfaceFactory: (Activity) -> View,
    )

    @Volatile
    private var overrides: Overrides? = null

    internal fun installForTest(
        controllerFactory: (Context, (PlaybackUiState) -> Unit) -> PlaybackController,
        surfaceFactory: (Activity) -> View,
    ) {
        overrides = Overrides(controllerFactory, surfaceFactory)
    }

    internal fun resetForTest() {
        overrides = null
    }

    fun createController(context: Context, listener: (PlaybackUiState) -> Unit): PlaybackController =
        createController(context, listener) { true }

    /** Wie oben, zusaetzlich mit der CX-083-Wiedergabefreigabe. */
    fun createController(
        context: Context,
        listener: (PlaybackUiState) -> Unit,
        playbackPermitted: () -> Boolean,
    ): PlaybackController =
        overrides?.controllerFactory?.invoke(context, listener)
            ?: PlaybackController(context, listener, playbackPermitted)

    fun createSurface(activity: Activity): View =
        overrides?.surfaceFactory?.invoke(activity) ?: createMedia3PlaybackSurface(activity)

    internal fun snapshotProvider(context: Context): () -> ActiveManifest? {
        val reader = PlaybackSnapshotReader(context.applicationContext)
        return reader::read
    }
}

/** Liest den aktivierten Stand ausschliesslich aus dem lokalen privaten Speicher. */
internal class PlaybackSnapshotReader(private val appContext: Context) {
    fun read(): ActiveManifest? {
        val dependencies = try {
            SyncRuntime.dependencies(appContext)
        } catch (_: Exception) {
            null
        } ?: return null
        return when (val loaded = dependencies.repository.load()) {
            is ManifestLoad.Active -> loaded.active
            else -> dependencies.repository.active()
        }
    }
}
