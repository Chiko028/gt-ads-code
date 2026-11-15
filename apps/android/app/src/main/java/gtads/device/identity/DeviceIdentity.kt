package gtads.device.identity

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.X509EncodedKeySpec

private const val ALIAS = "gtads.device.identity.v1"
private const val P256_CURVE = "secp256r1"
private const val ANDROID_KEYSTORE = "AndroidKeyStore"

/** Fehlerart; enthaelt nie Schluessel- oder Byteinhalt. */
enum class IdentityFailure { MISSING_ALIAS, INVALID_KEY, KEYSTORE_FAILURE, SIGNATURE_FAILURE }

/** Stabiler Fehler ohne Loeschung, Ersatz oder Software-Fallback. */
class DeviceIdentityException(val failure: IdentityFailure, cause: Throwable? = null) : Exception("Identitaet nicht verfuegbar: $failure", cause)

/** Interner Speicher; bewusst ohne Loeschoperation. */
internal interface IdentityKeyStore {
    fun contains(alias: String): Boolean
    fun createP256(alias: String)
    fun publicKeySpki(alias: String): ByteArray
    fun privateKey(alias: String): PrivateKey
}

/** AndroidKeyStore-Adapter fuer EC P-256 ohne Biometrie- oder StrongBox-Pflicht. */
internal class AndroidKeyStoreIdentityStore : IdentityKeyStore {
    private val keyStore: KeyStore by lazy {
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    }
    override fun contains(alias: String): Boolean = keyStore.containsAlias(alias)
    override fun createP256(alias: String) {
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE).run {
            initialize(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                    .setAlgorithmParameterSpec(ECGenParameterSpec(P256_CURVE))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .build(),
            )
            generateKeyPair()
        }
    }
    override fun publicKeySpki(alias: String): ByteArray =
        keyStore.getCertificate(alias)?.publicKey?.encoded
            ?: throw IllegalStateException("Kein Zertifikat fuer den Alias.")
    override fun privateKey(alias: String): PrivateKey =
        (keyStore.getEntry(alias, null) as? KeyStore.PrivateKeyEntry)?.privateKey
            ?: throw IllegalStateException("Kein privater Schluessel fuer den Alias.")
}

/** Nur [initializeForEnrollment] darf bei fehlendem Alias erzeugen; [openExisting]/[sign] nie. */
class DeviceIdentity internal constructor(private val store: IdentityKeyStore) {
    constructor() : this(AndroidKeyStoreIdentityStore())

    /** Erzeugt hoechstens einmal und liefert den oeffentlichen SPKI-Schluessel. */
    fun initializeForEnrollment(): ByteArray = synchronized(PROCESS_LOCK) {
        if (!containsAlias()) {
            try {
                store.createP256(ALIAS)
            } catch (cause: Exception) {
                throw DeviceIdentityException(IdentityFailure.KEYSTORE_FAILURE, cause)
            }
        }
        readVerifiedSpki()
    }

    /** Oeffnet eine vorhandene Identitaet ohne Erzeugung. */
    fun openExisting(): ByteArray = synchronized(PROCESS_LOCK) {
        if (!containsAlias()) {
            throw DeviceIdentityException(IdentityFailure.MISSING_ALIAS)
        }
        readVerifiedSpki()
    }

    /** Oeffentlicher SPKI-Schluessel ohne Erzeugung. */
    fun publicKeySpki(): ByteArray = openExisting()

    /** Signiert die uebergebenen Bytes unveraendert (SHA-256, ASN.1-DER). */
    fun sign(bytes: ByteArray): ByteArray {
        openExisting()
        val key = try {
            store.privateKey(ALIAS)
        } catch (cause: Exception) {
            throw DeviceIdentityException(IdentityFailure.INVALID_KEY, cause)
        }
        return try {
            signBytes(key, bytes)
        } catch (cause: Exception) {
            throw DeviceIdentityException(IdentityFailure.SIGNATURE_FAILURE, cause)
        }
    }

    private fun containsAlias(): Boolean = try {
        store.contains(ALIAS)
    } catch (cause: Exception) {
        throw DeviceIdentityException(IdentityFailure.KEYSTORE_FAILURE, cause)
    }

    private fun readVerifiedSpki(): ByteArray {
        val spki = try {
            store.publicKeySpki(ALIAS)
        } catch (cause: Exception) {
            throw DeviceIdentityException(IdentityFailure.INVALID_KEY, cause)
        }
        val key = try {
            KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spki)) as ECPublicKey
        } catch (cause: Exception) {
            throw DeviceIdentityException(IdentityFailure.INVALID_KEY, cause)
        }
        if (!isP256(key.params)) {
            throw DeviceIdentityException(IdentityFailure.INVALID_KEY)
        }
        return spki.copyOf()
    }

    private fun isP256(params: ECParameterSpec): Boolean = try {
        val expected = AlgorithmParameters.getInstance("EC").run {
            init(ECGenParameterSpec(P256_CURVE))
            getParameterSpec(ECParameterSpec::class.java)
        }
        params.curve == expected.curve &&
            params.generator == expected.generator &&
            params.order == expected.order &&
            params.cofactor == expected.cofactor
    } catch (_: Exception) {
        false
    }

    private companion object {
        /** Komponentenuebergreifende Prozesssperre fuer Pruefung und Erzeugung. */
        val PROCESS_LOCK = Any()

        /** Produktiver Signaturpfad, den auch der Android-Adapter nutzt. */
        fun signBytes(key: PrivateKey, bytes: ByteArray): ByteArray =
            Signature.getInstance("SHA256withECDSA").run {
                initSign(key)
                update(bytes)
                sign()
            }
    }
}
