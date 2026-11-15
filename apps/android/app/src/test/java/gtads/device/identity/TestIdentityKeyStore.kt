package gtads.device.identity

import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.spec.ECGenParameterSpec

internal const val TEST_ALIAS = "gtads.device.identity.v1"

internal fun newP256KeyPair(): KeyPair =
    KeyPairGenerator.getInstance("EC")
        .apply { initialize(ECGenParameterSpec("secp256r1")) }
        .generateKeyPair()

/** Minimaler injizierter Store; Schluessel entstehen ausschliesslich im Test. */
internal class TestIdentityKeyStore(
    initial: Map<String, KeyPair> = emptyMap(),
    private val spkiOverride: ((String) -> ByteArray)? = null,
    private val spkiFailure: RuntimeException? = null,
    private val privateKeyOverride: ((String) -> PrivateKey)? = null,
) : IdentityKeyStore {
    private val keys = LinkedHashMap(initial)
    val createdAliases = mutableListOf<String>()
    val createCalls: Int get() = createdAliases.size

    override fun contains(alias: String): Boolean = alias in keys

    override fun createP256(alias: String) {
        createdAliases += alias
        keys[alias] = newP256KeyPair()
    }

    override fun publicKeySpki(alias: String): ByteArray {
        spkiFailure?.let { throw it }
        spkiOverride?.let { return it(alias) }
        return keys.getValue(alias).getPublic().encoded
    }

    override fun privateKey(alias: String): PrivateKey {
        privateKeyOverride?.let { return it(alias) }
        return keys.getValue(alias).getPrivate()
    }

    fun keyPair(alias: String): KeyPair? = keys[alias]
}
