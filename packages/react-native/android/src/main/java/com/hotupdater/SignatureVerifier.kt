package com.hotupdater

import android.content.Context
import android.util.Base64
import android.util.Log
import java.security.KeyFactory
import java.security.PublicKey
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/**
 * Custom exceptions for signature verification errors.
 */
sealed class SignatureVerificationException(message: String) : Exception(message) {
    class PublicKeyNotConfigured : SignatureVerificationException(
        "Public key not configured for signature verification. " +
        "Add 'hot_updater_public_key' to res/values/strings.xml"
    )

    class InvalidPublicKeyFormat : SignatureVerificationException(
        "Public key format is invalid. Ensure the public key is in PEM format (BEGIN PUBLIC KEY)"
    )

    class InvalidSignatureFormat : SignatureVerificationException(
        "Signature format is invalid. The signature must be base64-encoded"
    )

    class VerificationFailed : SignatureVerificationException(
        "Bundle signature verification failed. The bundle may be corrupted or tampered with"
    )

    class SecurityFrameworkError(cause: Throwable) : SignatureVerificationException(
        "Security framework error during verification: ${cause.message}"
    )
}

/**
 * Service for verifying RSA-SHA256 signatures of bundle fileHash.
 * Uses Java Signature API for cryptographic operations.
 */
object SignatureVerifier {
    private const val TAG = "SignatureVerifier"

    /**
     * Reads public key from Android string resources.
     * @param context Application context
     * @return Public key PEM string or null if not configured
     */
    private fun getPublicKeyFromConfig(context: Context): String? {
        val resourceId = context.resources.getIdentifier(
            "hot_updater_public_key",
            "string",
            context.packageName
        )

        if (resourceId == 0) {
            Log.d(TAG, "hot_updater_public_key not found in strings.xml")
            return null
        }

        val publicKeyPEM = context.getString(resourceId)
        if (publicKeyPEM.isEmpty()) {
            Log.d(TAG, "hot_updater_public_key is empty")
            return null
        }

        return publicKeyPEM
    }

    /**
     * Converts PEM-formatted public key to PublicKey.
     * @param publicKeyPEM Public key in PEM format
     * @return PublicKey instance
     * @throws SignatureVerificationException.InvalidPublicKeyFormat if conversion fails
     */
    private fun createPublicKey(publicKeyPEM: String): PublicKey {
        try {
            // Remove PEM headers/footers and whitespace
            val publicKeyBase64 = publicKeyPEM
                .replace("-----BEGIN PUBLIC KEY-----", "")
                .replace("-----END PUBLIC KEY-----", "")
                .replace("\\n", "")
                .replace("\n", "")
                .replace("\r", "")
                .replace(" ", "")
                .trim()

            // Decode base64
            val keyBytes = Base64.decode(publicKeyBase64, Base64.DEFAULT)

            // Create PublicKey from X.509 format (SubjectPublicKeyInfo)
            val spec = X509EncodedKeySpec(keyBytes)
            val keyFactory = KeyFactory.getInstance("RSA")
            val publicKey = keyFactory.generatePublic(spec)

            Log.d(TAG, "Public key loaded successfully")
            return publicKey
        } catch (e: Exception) {
            Log.e(TAG, "Failed to create public key", e)
            throw SignatureVerificationException.InvalidPublicKeyFormat()
        }
    }

    /**
     * Converts hex string to ByteArray.
     * @param hexString Hex-encoded string
     * @return ByteArray
     * @throws SignatureVerificationException.InvalidSignatureFormat if conversion fails
     */
    private fun hexToByteArray(hexString: String): ByteArray {
        try {
            val len = hexString.length
            if (len % 2 != 0) {
                throw SignatureVerificationException.InvalidSignatureFormat()
            }

            val data = ByteArray(len / 2)
            var i = 0
            while (i < len) {
                data[i / 2] = ((Character.digit(hexString[i], 16) shl 4) +
                               Character.digit(hexString[i + 1], 16)).toByte()
                i += 2
            }
            return data
        } catch (e: Exception) {
            Log.e(TAG, "Failed to convert hex to byte array", e)
            throw SignatureVerificationException.InvalidSignatureFormat()
        }
    }

    /**
     * Verifies RSA-SHA256 signature of fileHash.
     * @param context Application context
     * @param fileHash SHA256 hash of bundle file (hex string)
     * @param signatureBase64 Base64-encoded RSA-SHA256 signature (nullable)
     * @throws SignatureVerificationException if verification fails
     */
    fun verifySignature(
        context: Context,
        fileHash: String,
        signatureBase64: String?
    ) {
        // Get public key from config
        val publicKeyPEM = getPublicKeyFromConfig(context)

        // If no signature provided, check if verification is required
        if (signatureBase64 == null) {
            if (publicKeyPEM != null) {
                Log.e(TAG, "Signature missing but verification is configured. Rejecting update.")
                throw SignatureVerificationException.VerificationFailed()
            }
            // No signature and no public key = signing not enabled, allow update
            Log.d(TAG, "Signature verification not configured. Skipping.")
            return
        }

        // Signature provided - verify it
        if (publicKeyPEM == null) {
            Log.e(TAG, "Cannot verify signature: public key not configured in strings.xml")
            throw SignatureVerificationException.PublicKeyNotConfigured()
        }

        try {
            // Convert PEM to PublicKey
            val publicKey = createPublicKey(publicKeyPEM)

            // Decode signature from base64
            val signatureBytes = try {
                Base64.decode(signatureBase64, Base64.DEFAULT)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to decode signature from base64", e)
                throw SignatureVerificationException.InvalidSignatureFormat()
            }

            // Convert hex fileHash to bytes
            val fileHashBytes = hexToByteArray(fileHash)

            // Verify signature using RSA-SHA256
            val verifier = Signature.getInstance("SHA256withRSA")
            verifier.initVerify(publicKey)
            verifier.update(fileHashBytes)
            val isValid = verifier.verify(signatureBytes)

            if (isValid) {
                Log.i(TAG, "✅ Signature verified successfully")
            } else {
                Log.e(TAG, "❌ Signature verification failed")
                throw SignatureVerificationException.VerificationFailed()
            }
        } catch (e: SignatureVerificationException) {
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "Signature verification error", e)
            throw SignatureVerificationException.SecurityFrameworkError(e)
        }
    }
}
