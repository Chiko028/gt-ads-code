package gtads.device.manifest

import org.json.JSONObject
import java.util.Base64

/**
 * Vertrauenswuerdige Medienmetadaten aus einem bereits signaturgeprueften
 * Manifest (CX-073). Die Instanz ist nur ueber [fromVerifiedManifest] oder
 * die modulinterne Fabrik [of] erreichbar; Medienname und URL tragen nichts
 * zur Identitaet bei.
 */
class VerifiedMedia private constructor(
    val mediaId: String,
    val sha256: String,
    val sizeBytes: Long,
) {
    companion object {
        private val SHA256_PATTERN = Regex("[0-9a-f]{64}")

        /**
         * Liest genau einen Eintrag aus den unveraenderten, bereits geprueften
         * Manifestbytes. Mehrdeutige oder ungueltige Eintraege ergeben null.
         */
        fun fromVerifiedManifest(manifest: ManifestVerification.Verified, mediaId: String): VerifiedMedia? {
            if (mediaId.isBlank()) return null
            return try {
                val envelope = JSONObject(String(manifest.bytes(), Charsets.UTF_8))
                val payloadBytes = Base64.getDecoder().decode(envelope.getString("payloadBase64"))
                val payload = JSONObject(String(payloadBytes, Charsets.UTF_8))
                val entries = payload.getJSONArray("entries")
                var match: JSONObject? = null
                for (index in 0 until entries.length()) {
                    val entry = entries.getJSONObject(index)
                    if (entry.optString("mediaId") == mediaId) {
                        if (match != null) return null
                        match = entry
                    }
                }
                val entry = match ?: return null
                val sha256 = entry.opt("sha256") as? String ?: return null
                val sizeBytes = when (val raw = entry.opt("sizeBytes")) {
                    is Int -> raw.toLong()
                    is Long -> raw
                    else -> return null
                }
                of(mediaId, sha256, sizeBytes)
            } catch (_: Exception) {
                null
            }
        }

        /** Modulinterne, validierende Fabrik; Tests derselben Quelle duerfen sie nutzen. */
        internal fun of(mediaId: String, sha256: String, sizeBytes: Long): VerifiedMedia? {
            if (mediaId.isBlank()) return null
            if (!SHA256_PATTERN.matches(sha256)) return null
            if (sizeBytes <= 0L) return null
            return VerifiedMedia(mediaId, sha256, sizeBytes)
        }
    }
}
