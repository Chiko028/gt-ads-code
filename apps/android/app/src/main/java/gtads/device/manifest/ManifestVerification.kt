package gtads.device.manifest
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.InvalidKeyException
import java.security.MessageDigest
import java.security.NoSuchAlgorithmException
import java.security.PublicKey
import java.security.Signature
import java.security.SignatureException
import java.security.interfaces.ECPublicKey
import java.time.Instant
import java.time.format.DateTimeParseException
import java.util.Base64
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
private const val MAX_ARTIFACT_BYTES = 1_048_576
private const val MAX_PAYLOAD_BYTES = 64 * 1024
private const val SIGNATURE_PREFIX = "gt-ads-manifest-v1"
private val KEY_ID_PATTERN = Regex("[A-Za-z0-9_-]{1,64}")
private val SHA256_PATTERN = Regex("[0-9a-f]{64}")
private val ENVELOPE_KEYS = arrayOf("schemaVersion", "keyId", "version", "payloadBase64", "signatureBase64")
private val PAYLOAD_KEYS = arrayOf("schemaVersion", "environment", "taxiId", "slotCount", "entries")
private val ENTRY_KEYS = arrayOf("mediaId", "sha256", "sizeBytes", "durationMs", "campaignId", "startAt", "endAt")
/** Feste, nutzdatenfreie Fehlercodes der Manifestpruefung. */

enum class ManifestFailure { SIZE, FORMAT, SIGNATURE, TAXI, CONTENT, CRYPTO_UNAVAILABLE }
/** Ergebnis der Pruefung; Erfolg enthaelt ausschliesslich die geprueften Originalbytes. */

sealed interface ManifestVerification {
    /** Nicht frei konstruierbar; jeder Bytezugriff liefert eine defensive Kopie. */
    class Verified private constructor(private val originalBytes: ByteArray) : ManifestVerification {
        fun bytes(): ByteArray = originalBytes.copyOf()
        companion object { internal fun of(bytes: ByteArray): Verified = Verified(bytes) }
    }
    /** Ablehnung mit festem Code, ohne Nutzdaten. */
    class Rejected(val code: ManifestFailure) : ManifestVerification
}

private class Envelope(
    val keyId: String,
    val version: String,
    val payloadBase64: String,
    val payloadBytes: ByteArray,
    val signatureBytes: ByteArray,
)

private class Payload(val taxiId: String)
private enum class SignatureStatus { OK, INVALID, UNAVAILABLE }
/**
 * Prueft ein Manifest-Artefakt gemaess CX-007/CX-042. Die Eingabe wird vor
 * jeder Auswertung kopiert; erst nach Groessen-, Huellen-, Signatur-, Hash-,
 * Inhalts- und Taxipruefung wird der Erfolg zurueckgegeben.
 */
fun verifyManifest(
    artifactBytes: ByteArray,
    trustedPublicKey: PublicKey,
    expectedTaxiId: String,
): ManifestVerification {
    val originalBytes = artifactBytes.copyOf()
    if (originalBytes.size > MAX_ARTIFACT_BYTES) return reject(ManifestFailure.SIZE)
    return try {
        verifyCopy(originalBytes, trustedPublicKey, expectedTaxiId)
    } catch (error: NoSuchAlgorithmException) {
        reject(ManifestFailure.CRYPTO_UNAVAILABLE)
    } catch (error: Exception) {
        reject(ManifestFailure.FORMAT)
    }
}

private fun verifyCopy(
    originalBytes: ByteArray,
    trustedPublicKey: PublicKey,
    expectedTaxiId: String,
): ManifestVerification {
    val envelope = parseEnvelope(originalBytes) ?: return reject(ManifestFailure.FORMAT)
    if (envelope.payloadBytes.size > MAX_PAYLOAD_BYTES) return reject(ManifestFailure.SIZE)
    when (signatureStatus(trustedPublicKey, envelope)) {
        SignatureStatus.OK -> Unit
        SignatureStatus.INVALID -> return reject(ManifestFailure.SIGNATURE)
        SignatureStatus.UNAVAILABLE -> return reject(ManifestFailure.CRYPTO_UNAVAILABLE)
    }
    if (sha256Hex(envelope.payloadBytes) != envelope.version) return reject(ManifestFailure.FORMAT)
    val payload = parsePayload(envelope.payloadBytes) ?: return reject(ManifestFailure.CONTENT)
    if (payload.taxiId != expectedTaxiId) return reject(ManifestFailure.TAXI)
    return ManifestVerification.Verified.of(originalBytes)
}

private fun parseEnvelope(bytes: ByteArray): Envelope? {
    val envelope = jsonObject(utf8(bytes) ?: return null) ?: return null
    if (!hasExactKeys(envelope, ENVELOPE_KEYS) || envelope.opt("schemaVersion") != 1) return null
    val keyId = envelope.opt("keyId") as? String ?: return null
    val version = envelope.opt("version") as? String ?: return null
    val payloadBase64 = envelope.opt("payloadBase64") as? String ?: return null
    val signatureBase64 = envelope.opt("signatureBase64") as? String ?: return null
    if (!KEY_ID_PATTERN.matches(keyId) || !SHA256_PATTERN.matches(version)) return null
    val payloadBytes = decodeBase64(payloadBase64) ?: return null
    val signatureBytes = decodeBase64(signatureBase64) ?: return null
    return Envelope(keyId, version, payloadBase64, payloadBytes, signatureBytes)
}

private fun signatureStatus(publicKey: PublicKey, envelope: Envelope): SignatureStatus {
    if (publicKey.algorithm != "EC") return SignatureStatus.UNAVAILABLE
    val ecKey = publicKey as? ECPublicKey ?: return SignatureStatus.UNAVAILABLE
    val parameters = ecKey.params
    if (parameters.curve.field.fieldSize != 256 || parameters.order.bitLength() != 256) {
        return SignatureStatus.UNAVAILABLE
    }
    val message = (SIGNATURE_PREFIX + "\n" + envelope.keyId + "\n" + envelope.version + "\n" + envelope.payloadBase64)
        .toByteArray(StandardCharsets.UTF_8)
    return try {
        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(publicKey)
        verifier.update(message)
        if (verifier.verify(envelope.signatureBytes)) SignatureStatus.OK else SignatureStatus.INVALID
    } catch (error: NoSuchAlgorithmException) {
        SignatureStatus.UNAVAILABLE
    } catch (error: InvalidKeyException) {
        SignatureStatus.UNAVAILABLE
    } catch (error: SignatureException) {
        SignatureStatus.INVALID
    } catch (error: RuntimeException) {
        SignatureStatus.UNAVAILABLE
    }
}

private fun parsePayload(bytes: ByteArray): Payload? {
    val payload = jsonObject(utf8(bytes) ?: return null) ?: return null
    if (!hasExactKeys(payload, PAYLOAD_KEYS) || payload.opt("schemaVersion") != 1) return null
    val environment = payload.opt("environment") as? String
    if (environment != "dev" && environment != "test") return null
    val taxiId = payload.opt("taxiId") as? String
    if (taxiId.isNullOrBlank()) return null
    val slotCount = positiveLong(payload.opt("slotCount")) ?: return null
    if (slotCount > Int.MAX_VALUE) return null
    val entries = payload.opt("entries") as? JSONArray ?: return null
    if (entries.length().toLong() != slotCount) return null
    for (index in 0 until entries.length()) {
        val entry = entries.opt(index) as? JSONObject ?: return null
        if (!validEntry(entry)) return null
    }
    return Payload(taxiId)
}

private fun validEntry(entry: JSONObject): Boolean {
    if (!hasExactKeys(entry, ENTRY_KEYS)) return false
    val mediaId = entry.opt("mediaId") as? String
    val sha256 = entry.opt("sha256") as? String
    val campaignId = entry.opt("campaignId") as? String
    val startAt = entry.opt("startAt") as? String
    val endAt = entry.opt("endAt") as? String
    if (mediaId.isNullOrBlank() || campaignId.isNullOrBlank()) return false
    if (sha256 == null || !SHA256_PATTERN.matches(sha256)) return false
    if (positiveLong(entry.opt("sizeBytes")) == null || positiveLong(entry.opt("durationMs")) == null) return false
    if (startAt == null || endAt == null) return false
    return validInterval(startAt, endAt)
}

private fun validInterval(startAt: String, endAt: String): Boolean = try {
    Instant.parse(startAt) < Instant.parse(endAt)
} catch (error: DateTimeParseException) {
    false
}
private fun positiveLong(value: Any?): Long? {
    val number = when (value) { is Int -> value.toLong(); is Long -> value; else -> return null }
    return if (number > 0) number else null
}
private fun hasExactKeys(value: JSONObject, keys: Array<String>): Boolean =
    value.length() == keys.size && keys.all { value.has(it) }
private fun utf8(bytes: ByteArray): String? = try {
    StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString()
} catch (error: CharacterCodingException) {
    null
}
private fun jsonObject(text: String): JSONObject? = try {
    JSONObject(text)
} catch (error: JSONException) {
    null
}
private fun decodeBase64(value: String): ByteArray? {
    if (value.isEmpty()) return null
    return try {
        val decoded = Base64.getDecoder().decode(value)
        if (Base64.getEncoder().encodeToString(decoded) == value) decoded else null
    } catch (error: IllegalArgumentException) {
        null
    }
}
private fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
private fun reject(code: ManifestFailure): ManifestVerification = ManifestVerification.Rejected(code)
