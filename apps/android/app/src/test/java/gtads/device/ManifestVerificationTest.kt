package gtads.device

import gtads.device.manifest.ManifestFailure
import gtads.device.manifest.ManifestVerification
import gtads.device.manifest.verifyManifest
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ManifestVerificationTest {
    private val keyPair: KeyPair = newKeyPair()
    private val otherKeyPair: KeyPair = newKeyPair()

    private fun newKeyPair(): KeyPair =
        KeyPairGenerator.getInstance("EC").apply {
            initialize(ECGenParameterSpec("secp256r1"))
        }.generateKeyPair()

    private fun entry(
        mediaId: String = "SYN-media",
        sha256: String = "a".repeat(64),
        sizeBytes: Long = 4096,
        durationMs: Long = 5000,
        campaignId: String = "SYN-campaign",
        startAt: String = "2026-12-01T08:00:00.000Z",
        endAt: String = "2026-12-01T18:00:00.000Z",
    ): JSONObject = JSONObject()
        .put("mediaId", mediaId)
        .put("sha256", sha256)
        .put("sizeBytes", sizeBytes)
        .put("durationMs", durationMs)
        .put("campaignId", campaignId)
        .put("startAt", startAt)
        .put("endAt", endAt)

    private fun payload(
        schemaVersion: Int = 1,
        taxiId: String = TAXI_ID,
        slotCount: Int = 1,
        entries: JSONArray = JSONArray().put(entry()),
    ): JSONObject = JSONObject()
        .put("schemaVersion", schemaVersion)
        .put("environment", "dev")
        .put("taxiId", taxiId)
        .put("slotCount", slotCount)
        .put("entries", entries)

    private fun sign(
        payloadText: String,
        privateKey: PrivateKey = keyPair.private,
        keyId: String = KEY_ID,
    ): ByteArray {
        val payloadBytes = payloadText.toByteArray(Charsets.UTF_8)
        val payloadBase64 = Base64.getEncoder().encodeToString(payloadBytes)
        val version = sha256Hex(payloadBytes)
        val message = "gt-ads-manifest-v1\n" + keyId + "\n" + version + "\n" + payloadBase64
        val signature = Signature.getInstance("SHA256withECDSA").run {
            initSign(privateKey)
            update(message.toByteArray(Charsets.UTF_8))
            sign()
        }
        val envelope = JSONObject()
            .put("schemaVersion", 1)
            .put("keyId", keyId)
            .put("version", version)
            .put("payloadBase64", payloadBase64)
            .put("signatureBase64", Base64.getEncoder().encodeToString(signature))
        return envelope.toString().toByteArray(Charsets.UTF_8)
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

    private fun mutateSignature(bytes: ByteArray): ByteArray {
        val envelope = JSONObject(String(bytes, Charsets.UTF_8))
        val signature = Base64.getDecoder().decode(envelope.getString("signatureBase64"))
        signature[0] = (signature[0].toInt() xor 1).toByte()
        envelope.put("signatureBase64", Base64.getEncoder().encodeToString(signature))
        return envelope.toString().toByteArray(Charsets.UTF_8)
    }

    @Test
    fun validAndFallbackManifestsAreAcceptedWithDefensiveCopies() {
        val original = sign(payload().toString())
        val expected = original.copyOf()

        val result = verifyManifest(original, keyPair.public, TAXI_ID)
        assertTrue(result is ManifestVerification.Verified)
        val verified = result as ManifestVerification.Verified
        assertArrayEquals(expected, verified.bytes())

        val returnedCopy = verified.bytes()
        returnedCopy[0] = (returnedCopy[0].toInt() xor 0x7f).toByte()
        assertArrayEquals(expected, verified.bytes())

        original[0] = (original[0].toInt() xor 0x7f).toByte()
        assertArrayEquals(expected, verified.bytes())

        val fallback = payload(
            entries = JSONArray().put(
                entry(
                    campaignId = "gt-ads-fallback",
                    startAt = "1970-01-01T00:00:00.000Z",
                    endAt = "9999-12-31T23:59:59.999Z",
                ),
            ),
        )
        val fallbackResult = verifyManifest(sign(fallback.toString()), keyPair.public, TAXI_ID)
        assertTrue(fallbackResult is ManifestVerification.Verified)
    }

    private data class RejectionCase(
        val name: String,
        val bytes: ByteArray,
        val key: PublicKey,
        val taxiId: String,
        val expected: ManifestFailure,
    )

    @Test
    fun invalidManifestsAreRejectedWithStableCodes() {
        val valid = sign(payload().toString())

        val missingField = payload()
        missingField.getJSONArray("entries").getJSONObject(0).remove("campaignId")

        val unknownSchema = payload(schemaVersion = 2)
        val badSha = payload(entries = JSONArray().put(entry(sha256 = "abc")))
        val zeroSize = payload(entries = JSONArray().put(entry(sizeBytes = 0)))
        val negativeSize = payload(entries = JSONArray().put(entry(sizeBytes = -1)))
        val malformed = "{\"schemaVersion\":1,\"keyId\":".toByteArray(Charsets.UTF_8)

        val cases = listOf(
            RejectionCase("manipulierte Signatur", mutateSignature(valid), keyPair.public, TAXI_ID, ManifestFailure.SIGNATURE),
            RejectionCase("falscher Vertrauensschluessel", valid, otherKeyPair.public, TAXI_ID, ManifestFailure.SIGNATURE),
            RejectionCase("falsches Taxi", valid, keyPair.public, "SYN-other-taxi", ManifestFailure.TAXI),
            RejectionCase("uebergrosse Eingabe", ByteArray(1_048_577), keyPair.public, TAXI_ID, ManifestFailure.SIZE),
            RejectionCase("fehlerhafte Huelle", malformed, keyPair.public, TAXI_ID, ManifestFailure.FORMAT),
            RejectionCase("fehlendes Pflichtfeld", sign(missingField.toString()), keyPair.public, TAXI_ID, ManifestFailure.CONTENT),
            RejectionCase("unbekannte Schemaversion", sign(unknownSchema.toString()), keyPair.public, TAXI_ID, ManifestFailure.CONTENT),
            RejectionCase("ungueltiger sha256", sign(badSha.toString()), keyPair.public, TAXI_ID, ManifestFailure.CONTENT),
            RejectionCase("sizeBytes null", sign(zeroSize.toString()), keyPair.public, TAXI_ID, ManifestFailure.CONTENT),
            RejectionCase("sizeBytes negativ", sign(negativeSize.toString()), keyPair.public, TAXI_ID, ManifestFailure.CONTENT),
        )

        for (case in cases) {
            val result = verifyManifest(case.bytes, case.key, case.taxiId)
            assertTrue(case.name, result is ManifestVerification.Rejected)
            assertEquals(case.name, case.expected, (result as ManifestVerification.Rejected).code)
        }
    }

    private companion object {
        private const val TAXI_ID = "SYN-taxi-001"
        private const val KEY_ID = "cx073-test-key"
    }
}
