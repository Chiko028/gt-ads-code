package gtads.device.sync

import android.content.Context
import gtads.device.download.MediaDownloadResult
import gtads.device.manifest.ManifestFetchResult
import gtads.device.manifest.ManifestRepository
import gtads.device.manifest.VerifiedManifestState
import gtads.device.manifest.VerifiedMedia
import java.security.PublicKey

/** Feste, nutzdatenfreie Sync-Fehler; der aktive lokale Stand bleibt jeweils erhalten. */
enum class SyncFailure {
    /** Freier privater Speicher reicht fuer die naechste Datei plus Reserve nicht aus. */
    STORAGE_FULL,

    /** Manifest- oder Medienintegritaet lokal nicht gegeben. */
    INTEGRITY,

    /** Der lokale App-Speicher konnte den Stand nicht schreiben. */
    STORAGE,

    /** Die Download-Freigabe ist abgelaufen und auch nach einem Manifestabruf nicht nutzbar. */
    GRANT_EXPIRED,

    /** Fuer ein Medium ist keine Download-Freigabe verfuegbar. */
    GRANT_UNAVAILABLE,

    /** Lokal unbrauchbarer Aufruf oder unerwartete Antwort. */
    INVALID_INPUT,
}

/** Ergebnis genau eines serialisierten Synchronisierungslaufs. */
sealed interface SyncRunResult {
    /** Ein neuer Kandidat wurde vollstaendig geladen und atomar aktiviert. */
    data object Activated : SyncRunResult

    /** Der aktive Stand ist bereits aktuell; es wurde nichts geladen. */
    data object Unchanged : SyncRunResult

    /** Ein anderer Lauf haelt die prozessweite Sperre; dieser Lauf tut nichts. */
    data object Busy : SyncRunResult

    /** 401/403: bis zu einer expliziten erfolgreichen Authentifizierung ruhen. */
    data object AuthenticationBlocked : SyncRunResult

    /** Die Achtdreiminutengrenze wurde erreicht; spaeter fortsetzen. */
    data object Incomplete : SyncRunResult

    /** Abbruch wurde beobachtet; Teilbytes bleiben erhalten. */
    data object Cancelled : SyncRunResult

    /** Voruebergehend nicht moeglich; WorkManager-Retry mit Backoff. */
    data object Transient : SyncRunResult

    /** Fester Fehler; kein automatischer Retry. */
    data class Failed(val code: SyncFailure) : SyncRunResult
}

/** Serialisierte Authentifizierungssperre; wird nur durch explizite Authentifizierung geloest. */
interface SyncAuthState {
    fun isSuspended(): Boolean

    fun suspend()

    fun resume()
}

/** Persistente Sperre im privaten App-Speicher. */
class SyncAuthGate(context: Context) : SyncAuthState {
    private val preferences = context.applicationContext
        .getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    override fun isSuspended(): Boolean = preferences.getBoolean(KEY_SUSPENDED, false)

    override fun suspend() {
        preferences.edit().putBoolean(KEY_SUSPENDED, true).apply()
    }

    override fun resume() {
        preferences.edit().putBoolean(KEY_SUSPENDED, false).apply()
    }

    private companion object {
        const val PREFERENCES_NAME = "gt-ads-sync-auth"
        const val KEY_SUSPENDED = "suspended"
    }
}

/** Alle austauschbaren Abhaengigkeiten eines Laufs; produktiv aus CX-074 bis CX-076 verdrahtet. */
class SyncDependencies(
    val repository: ManifestRepository,
    val mediaDirectory: java.io.File,
    val fetchManifest: (VerifiedManifestState?) -> ManifestFetchResult,
    val grantUrl: (VerifiedMedia) -> String?,
    val downloadMedia: (String, VerifiedMedia) -> MediaDownloadResult,
    val freeSpaceBytes: () -> Long,
    val authState: SyncAuthState,
    val nowMs: () -> Long,
    val isCancelled: () -> Boolean = { false },
)

/**
 * Konfiguration, die CX-077 nicht selbst erfinden darf: Vertrauensschluessel,
 * Taxi-ID und die Beschaffung der signierten Download-Freigabe stammen aus
 * vorgelagerten Paketen und werden hier injiziert.
 */
class SyncConfiguration(
    val taxiId: String,
    val trustedManifestKey: PublicKey,
    val grantUrl: (VerifiedMedia) -> String?,
)

