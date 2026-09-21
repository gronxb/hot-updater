package com.hotupdater.lynx.internal

import android.util.Base64
import java.io.File
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/** Preserves Hot Updater's RSA-SHA256 signature of the SHA-256 digest bytes. */
internal class ArchiveIntegrity(private val publicKeyPem: String?) {
    private val publicKey = publicKeyPem?.let { pem ->
        require(pem.contains("-----BEGIN PUBLIC KEY-----") && pem.contains("-----END PUBLIC KEY-----")) { "Invalid configured public key" }
        val body = pem.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").replace(Regex("\\s"), "")
        KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(Base64.decode(body, Base64.NO_WRAP)))
    }
    val keyIdentity: String = publicKey?.encoded?.let { bytes -> MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) } } ?: "unsigned"

    fun verifyAsset(file: File, expectedHash: String, signature: String?) {
        require(expectedHash.matches(Regex("[0-9a-fA-F]{64}"))) { "Invalid asset hash" }
        check(HashUtils.calculateSHA256(file).equals(expectedHash, ignoreCase = true)) { "Managed asset hash mismatch" }
        if (publicKey != null) verify(file, "sig:" + requireNotNull(signature) { "Missing configured asset signature" })
    }

    fun verify(file: File, expected: String) {
        require(expected.isNotBlank()) { "Archive hash is required" }
        val digest = HashUtils.calculateSHA256(file)
        if (expected.startsWith("sig:")) {
            check(publicKey != null) { "Signed archive requires a configured public key" }
            val encoded = expected.removePrefix("sig:")
            require(encoded.isNotEmpty() && encoded.matches(Regex("[A-Za-z0-9+/]+={0,2}"))) { "Malformed archive signature" }
            val signature = Base64.decode(encoded, Base64.NO_WRAP)
            val verifier = Signature.getInstance("SHA256withRSA")
            verifier.initVerify(publicKey)
            verifier.update(digest.chunked(2).map { it.toInt(16).toByte() }.toByteArray())
            check(verifier.verify(signature)) { "Archive signature mismatch" }
        } else {
            check(publicKey == null) { "Unsigned archive rejected by configured signing policy" }
            require(expected.matches(Regex("[0-9a-fA-F]{64}"))) { "Malformed archive hash" }
            check(digest.equals(expected, ignoreCase = true)) { "Archive hash mismatch" }
        }
    }
}
