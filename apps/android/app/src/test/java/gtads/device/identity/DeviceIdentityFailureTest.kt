package gtads.device.identity

import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

@RunWith(Parameterized::class)
class DeviceIdentityFailureTest(
    private val label: String,
    private val kind: Kind,
    private val expected: IdentityFailure,
) {
    enum class Kind {
        MISSING_OPEN,
        MISSING_SIGN,
        DAMAGED_SPKI,
        RSA_SPKI,
        P384_SPKI,
        UNREADABLE_ENTRY,
        SIGNING_KEY,
        UNREADABLE_PRIVATE,
    }

    companion object {
        private fun rsaKeyPair(): KeyPair =
            KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()

        private fun p384KeyPair(): KeyPair =
            KeyPairGenerator.getInstance("EC")
                .apply { initialize(ECGenParameterSpec("secp384r1")) }
                .generateKeyPair()

        @JvmStatic
        @Parameterized.Parameters(name = "{index}: {0}")
        fun cases(): List<Array<Any>> = listOf(
            arrayOf("fehlender Alias beim Oeffnen", Kind.MISSING_OPEN, IdentityFailure.MISSING_ALIAS),
            arrayOf("fehlender Alias beim Signieren", Kind.MISSING_SIGN, IdentityFailure.MISSING_ALIAS),
            arrayOf("beschaedigter SPKI", Kind.DAMAGED_SPKI, IdentityFailure.INVALID_KEY),
            arrayOf("RSA statt EC", Kind.RSA_SPKI, IdentityFailure.INVALID_KEY),
            arrayOf("P-384 statt P-256", Kind.P384_SPKI, IdentityFailure.INVALID_KEY),
            arrayOf("nicht lesbarer Eintrag", Kind.UNREADABLE_ENTRY, IdentityFailure.INVALID_KEY),
            arrayOf("ungeeigneter privater Schluessel beim Signieren", Kind.SIGNING_KEY, IdentityFailure.INVALID_KEY),
            arrayOf("privater Schluessel nicht lesbar", Kind.UNREADABLE_PRIVATE, IdentityFailure.INVALID_KEY),
        )
    }

    @Test
    fun rejectsWithoutDeletionReplacementOrAutomaticCreation() {
        val valid = newP256KeyPair()
        val store = when (kind) {
            Kind.MISSING_OPEN, Kind.MISSING_SIGN -> TestIdentityKeyStore()
            Kind.DAMAGED_SPKI -> TestIdentityKeyStore(
                mapOf(TEST_ALIAS to valid),
                spkiOverride = { byteArrayOf(0, 1, 2) },
            )
            Kind.RSA_SPKI -> TestIdentityKeyStore(
                mapOf(TEST_ALIAS to valid),
                spkiOverride = { rsaKeyPair().getPublic().encoded },
            )
            Kind.P384_SPKI -> TestIdentityKeyStore(
                mapOf(TEST_ALIAS to valid),
                spkiOverride = { p384KeyPair().getPublic().encoded },
            )
            Kind.UNREADABLE_ENTRY -> TestIdentityKeyStore(
                mapOf(TEST_ALIAS to valid),
                spkiFailure = IllegalStateException("beschaedigt"),
            )
            Kind.SIGNING_KEY -> TestIdentityKeyStore(
                mapOf(TEST_ALIAS to valid),
                privateKeyOverride = { rsaKeyPair().getPrivate() },
            )
            Kind.UNREADABLE_PRIVATE -> TestIdentityKeyStore(
                mapOf(TEST_ALIAS to valid),
                privateKeyOverride = { throw IllegalStateException("beschaedigt") },
            )
        }
        val beforeKey = store.keyPair(TEST_ALIAS)
        val beforePresent = store.contains(TEST_ALIAS)

        val thrown = assertThrows(DeviceIdentityException::class.java) {
            when (kind) {
                Kind.MISSING_OPEN, Kind.DAMAGED_SPKI, Kind.RSA_SPKI,
                Kind.P384_SPKI, Kind.UNREADABLE_ENTRY -> DeviceIdentity(store).openExisting()
                Kind.MISSING_SIGN, Kind.SIGNING_KEY, Kind.UNREADABLE_PRIVATE -> DeviceIdentity(store).sign(byteArrayOf(0, 1, 2))
            }
        }

        assertEquals(label, expected, thrown.failure)
        assertEquals("keine automatische Erzeugung", 0, store.createCalls)
        assertEquals("Alias bleibt vorhanden bzw. fehlend", beforePresent, store.contains(TEST_ALIAS))
        assertSame("kein Ersatz und keine Loeschung", beforeKey, store.keyPair(TEST_ALIAS))
    }
}
