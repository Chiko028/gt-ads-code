package gtads.device.identity

import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PublicKey
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceIdentitySignatureTest {
    @Test
    fun signsBinaryBytesUnchangedWithTheProductiveJcaPath() {
        val pair = newP256KeyPair()
        val store = TestIdentityKeyStore(mapOf(TEST_ALIAS to pair))
        val identity = DeviceIdentity(store)
        val payload = byteArrayOf(0x00, 0x01, 0x7f, -0x80, -0x01, 0x0a, 0x0d, 0x42)

        val signature = identity.sign(payload)
        val publicKey = KeyFactory.getInstance("EC")
            .generatePublic(X509EncodedKeySpec(identity.openExisting()))

        assertEquals("keine Erzeugung beim Signieren", 0, store.createCalls)
        assertEquals("ASN.1-DER-Sequenz", 0x30, signature[0].toInt() and 0xff)
        assertTrue("unveraenderte Bytes", verify(publicKey, payload, signature))
        assertFalse("angehaengtes Byte", verify(publicKey, payload + byteArrayOf(0x00), signature))
        val flipped = payload.copyOf().also { it[3] = (it[3].toInt() xor 0x01).toByte() }
        assertFalse("veraendertes Byte", verify(publicKey, flipped, signature))
        assertFalse("anderer oeffentlicher Schluessel", verify(newP256KeyPair().getPublic(), payload, signature))
    }

    @Test
    fun reportsSignatureFailureWhenTheSigningStepFailsAfterSuccessfulVerification() {
        val pair = newP256KeyPair()
        var privateKeyReads = 0
        val store = TestIdentityKeyStore(
            mapOf(TEST_ALIAS to pair),
            privateKeyOverride = {
                privateKeyReads += 1
                if (privateKeyReads == 1) pair.private else rsaKeyPair().private
            },
        )

        val thrown = assertThrows(DeviceIdentityException::class.java) {
            DeviceIdentity(store).sign(byteArrayOf(0x01))
        }

        assertEquals("Signaturfehler getrennt von der Schluesselpruefung", IdentityFailure.SIGNATURE_FAILURE, thrown.failure)
        assertEquals("keine Erzeugung beim Signieren", 0, store.createCalls)
        assertSame("kein Ersatz und keine Loeschung", pair, store.keyPair(TEST_ALIAS))
    }

    private fun rsaKeyPair(): KeyPair =
        KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()

    private fun verify(publicKey: PublicKey, bytes: ByteArray, signature: ByteArray): Boolean =
        Signature.getInstance("SHA256withECDSA").run {
            initVerify(publicKey)
            update(bytes)
            verify(signature)
        }
}
