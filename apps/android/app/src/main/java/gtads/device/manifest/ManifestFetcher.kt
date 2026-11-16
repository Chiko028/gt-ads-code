package gtads.device.manifest

import android.os.Looper
import gtads.device.auth.DeviceAuthClient
import gtads.device.auth.DeviceAuthResult
import gtads.device.auth.DeviceHttp
import gtads.device.auth.DeviceHttpResult
import java.net.HttpURLConnection
import java.net.URL
import java.security.PublicKey

/** Zuletzt erfolgreich geprueftes Artefakt mit dem ETag, unter dem es geliefert wurde. */
class VerifiedManifestState(val manifest: ManifestVerification.Verified, val etag: String)

/** Ergebnis genau eines Manifestabrufs (CX-074 / R-902); aktiviert und speichert nichts. */
sealed interface ManifestFetchResult {
    /** HTTP 200 und vollstaendig gepruefter Kandidat (CX-073) samt ETag. */
    class Candidate(val state: VerifiedManifestState) : ManifestFetchResult

    /** HTTP 304 zu einem tatsaechlich geprueften lokalen Stand: unveraendert. */
    data object Unchanged : ManifestFetchResult

    /** Anmeldung abgelehnt (401/403); keine automatische Wiederholung, Identitaet bleibt. */
    data object AuthenticationRequired : ManifestFetchResult

    data object Timeout : ManifestFetchResult

    /** Antwort groesser als 1 MiB (auch nach Dekomprimierung). */
    data object TooLarge : ManifestFetchResult

    /** Netzfehler, 429/5xx oder unbrauchbare Serverantwort; letzter geprufter Stand bleibt. */
    data object Unavailable : ManifestFetchResult

    /** Geliefertes Artefakt hat die Pruefung nicht bestanden. */
    data class Invalid(val code: ManifestFailure) : ManifestFetchResult

    /** 304 ohne geprueften Ausgangsstand, Weiterleitung oder sonstige unerwartete Antwort. */
    data class Unexpected(val status: Int) : ManifestFetchResult

    /** Lokal nicht moeglich (Hauptthread, ungueltige Basis-URL). */
    data object InvalidInput : ManifestFetchResult
}

/**
 * Einmaliger, authentifizierter Abruf von GET /v1/device/manifest (CX-042).
 * Anmeldung ueber DeviceAuthClient (Challenge/Response), Pruefung ueber verifyManifest
 * (CX-073). If-None-Match wird nur fuer einen tatsaechlich geprueften Stand gesendet.
 * Zeitlimits je 15 s, Antwort hoechstens 1 MiB, keine Weiterleitungen, keine Protokollierung.
 */
class ManifestFetcher(
    baseUrl: String,
    private val auth: DeviceAuthClient,
    private val trustedPublicKey: PublicKey,
    private val expectedTaxiId: String,
    openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
    private val onMainThread: () -> Boolean = { Looper.myLooper() == Looper.getMainLooper() },
) {
    private val http = DeviceHttp(baseUrl, openConnection, TIMEOUT_MS, TIMEOUT_MS)

    fun fetch(current: VerifiedManifestState?): ManifestFetchResult {
        if (onMainThread()) return ManifestFetchResult.InvalidInput
        val token = when (val authResult = auth.obtainToken()) {
            is DeviceAuthResult.Token -> authResult.accessToken
            DeviceAuthResult.AuthenticationRequired -> return ManifestFetchResult.AuthenticationRequired
            DeviceAuthResult.Unavailable -> return ManifestFetchResult.Unavailable
            DeviceAuthResult.InvalidInput -> return ManifestFetchResult.InvalidInput
        }
        val response = when (val result = http.call("GET", MANIFEST_PATH, null, token, current?.etag, MAX_MANIFEST_BYTES)) {
            is DeviceHttpResult.Response -> result
            DeviceHttpResult.Timeout -> return ManifestFetchResult.Timeout
            DeviceHttpResult.TooLarge -> return ManifestFetchResult.TooLarge
            DeviceHttpResult.Network -> return ManifestFetchResult.Unavailable
            DeviceHttpResult.InvalidTarget -> return ManifestFetchResult.InvalidInput
        }
        return when (response.status) {
            200 -> candidate(response)
            304 -> if (current != null && response.etag == current.etag) {
                ManifestFetchResult.Unchanged
            } else {
                ManifestFetchResult.Unexpected(304)
            }
            401, 403 -> ManifestFetchResult.AuthenticationRequired
            429, in 500..599 -> ManifestFetchResult.Unavailable
            else -> ManifestFetchResult.Unexpected(response.status)
        }
    }

    private fun candidate(response: DeviceHttpResult.Response): ManifestFetchResult {
        val etag = response.etag?.takeIf { it.isNotBlank() } ?: return ManifestFetchResult.Unavailable
        return when (val verification = verifyManifest(response.body, trustedPublicKey, expectedTaxiId)) {
            is ManifestVerification.Verified -> ManifestFetchResult.Candidate(VerifiedManifestState(verification, etag))
            is ManifestVerification.Rejected -> ManifestFetchResult.Invalid(verification.code)
        }
    }

    companion object {
        const val TIMEOUT_MS = 15_000
        const val MAX_MANIFEST_BYTES = 1_048_576
        private const val MANIFEST_PATH = "/v1/device/manifest"
    }
}
