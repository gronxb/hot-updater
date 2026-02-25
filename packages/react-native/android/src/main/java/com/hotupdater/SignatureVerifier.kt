package com.hotupdater

import android.content.Context
import android.util.Base64
import android.util.Log
import java.io.File
import java.security.KeyFactory
import java.security.PublicKey
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/**
 * Prefix for signed file hash format.
 */
private const val SIGNED_HASH_PREFIX = "sig:"

/**
 * Custom exceptions for signature verification errors.
 *
 * **IMPORTANT**: The error messages in these exceptions are used by the JavaScript layer
 * (`packages/react-native/src/types.ts`) to detect signature verification failures.
 * If you change these messages, update `isSignatureVerificationError()` in types.ts accordingly.
 */
sealed class SignatureVerificationException(
    message: String,
) : Exception(message) {
    class PublicKeyNotConfigured :
        SignatureVerificationException(
            "Public key not configured for signature verification. " +
                "Add 'hot_updater_public_key' to res/values/strings.xml",
        )

    class InvalidPublicKeyFormat :
        SignatureVerificationException(
            "Public key format is invalid. Ensure the public key is in PEM format (BEGIN PUBLIC KEY)",
        )

    class MissingFileHash :
        SignatureVerificationException(
            "File hash is missing or empty. Ensure the bundle update includes a valid file hash",
        )

    class InvalidSignatureFormat :
        SignatureVerificationException(
            "Signature format is invalid or corrupted. The signature data is malformed or cannot be decoded",
        )

    class SignatureVerificationFailed :
        SignatureVerificationException(
            "Bundle signature verification failed. The bundle may be corrupted or tampered with",
        )

    class FileHashMismatch :
        SignatureVerificationException(
            "File hash verification failed. The bundle file hash does not match the expected value. File may be corrupted",
        )

    class FileReadFailed :
        SignatureVerificationException(
            "Failed to read file for verification. Could not read file for hash verification",
        )

    class UnsignedNotAllowed :
        SignatureVerificationException(
            "Unsigned bundle not allowed when signing is enabled. " +
                "Public key is configured but bundle is not signed. Rejecting update",
        )

    class SecurityFrameworkError(
        cause: Throwable,
    ) : SignatureVerificationException(
            "Security framework error during verification: ${cause.message}",
        )
}

/**
 * Service for verifying bundle integrity through hash or RSA-SHA256 signature verification.
 * Uses Java Signature API for cryptographic operations.
 *
 * fileHash format:
 * - Signed: `sig:<base64_signature>` - Verify signature (implicitly verifies hash)
 * - Unsigned: `<hex_hash>` - Verify SHA256 hash only
 *
 * Security rules:
 * - null/empty fileHash → REJECT
 * - sig:... + public key configured → verify signature → Install/REJECT
 * - sig:... + public key NOT configured → REJECT (can't verify)
 * - <hash> + public key configured → REJECT (unsigned not allowed)
 * - <hash> + public key NOT configured → verify hash → Install/REJECT
 */
object SignatureVerifier {
    private const val TAG = "SignatureVerifier"

    /**
     * Reads public key from Android string resources.
     * @param context Application context
     * @return Public key PEM string or null if not configured
     */
    private fun getPublicKeyFromConfig(context: Context): String? {
        val resourceId = StringResourceUtils.getIdentifier(context, "hot_updater_public_key")

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
     * Checks if signing is enabled (public key is configured).
     * @param context Application context
     * @return true if public key is configured
     */
    fun isSigningEnabled(context: Context): Boolean = getPublicKeyFromConfig(context) != null

    /**
     * Checks if fileHash is in signed format (starts with "sig:").
     * @param fileHash The file hash string to check
     * @return true if signed format
     */
    fun isSignedFormat(fileHash: String?): Boolean = fileHash?.startsWith(SIGNED_HASH_PREFIX) == true

    /**
     * Extracts signature from signed format fileHash.
     * @param fileHash The signed file hash (sig:<signature>)
     * @return Base64-encoded signature or null if not signed format
     */
    fun extractSignature(fileHash: String?): String? {
        if (!isSignedFormat(fileHash)) return null
        return fileHash?.removePrefix(SIGNED_HASH_PREFIX)
    }

    /**
     * Verifies bundle integrity based on fileHash format.
     * Determines verification mode by checking for "sig:" prefix.
     *
     * @param context Application context
     * @param bundleFile The bundle file to verify
     * @param fileHash Combined hash string (sig:<signature> or <hex_hash>)
     * @throws SignatureVerificationException if verification fails
     */
    fun verifyBundle(
        context: Context,
        bundleFile: File,
        fileHash: String?,
    ) {
        val signingEnabled = isSigningEnabled(context)

        // Rule: null/empty fileHash → REJECT
        if (fileHash.isNullOrEmpty()) {
            Log.e(TAG, "fileHash is null or empty. Rejecting update.")
            throw SignatureVerificationException.MissingFileHash()
        }

        if (isSignedFormat(fileHash)) {
            // Signed format: sig:<signature>
            val signature = extractSignature(fileHash)
            if (signature.isNullOrEmpty()) {
                Log.e(TAG, "Failed to extract signature from fileHash")
                throw SignatureVerificationException.InvalidSignatureFormat()
            }

            // Rule: sig:... + public key NOT configured → REJECT
            if (!signingEnabled) {
                Log.e(TAG, "Signed bundle but public key not configured. Cannot verify.")
                throw SignatureVerificationException.PublicKeyNotConfigured()
            }

            // Rule: sig:... + public key configured → verify signature
            verifySignature(context, bundleFile, signature)
        } else {
            // Unsigned format: <hex_hash>

            // Rule: <hash> + public key configured → REJECT
            if (signingEnabled) {
                Log.e(TAG, "Unsigned bundle not allowed when signing is enabled. Rejecting.")
                throw SignatureVerificationException.UnsignedNotAllowed()
            }

            // Rule: <hash> + public key NOT configured → verify hash
            verifyHash(bundleFile, fileHash)
        }
    }

    /**
     * Verifies SHA256 hash of a file.
     * @param bundleFile The file to verify
     * @param expectedHash Expected SHA256 hash (hex string)
     * @throws SignatureVerificationException.FileHashMismatch if verification fails
     */
    fun verifyHash(
        bundleFile: File,
        expectedHash: String,
    ) {
        Log.d(TAG, "Verifying hash for file: ${bundleFile.name}")

        if (!HashUtils.verifyHash(bundleFile, expectedHash)) {
            Log.e(TAG, "Hash mismatch!")
            throw SignatureVerificationException.FileHashMismatch()
        }

        Log.i(TAG, "✅ Hash verified successfully")
    }

    /**
     * Verifies RSA-SHA256 signature of a file.
     * Calculates the file hash internally and verifies the signature.
     *
     * @param context Application context
     * @param bundleFile The file to verify
     * @param signatureBase64 Base64-encoded RSA-SHA256 signature
     * @throws SignatureVerificationException if verification fails
     */
    fun verifySignature(
        context: Context,
        bundleFile: File,
        signatureBase64: String,
    ) {
        Log.d(TAG, "Verifying signature for file: ${bundleFile.name}")

        // Get public key from config
        val publicKeyPEM =
            getPublicKeyFromConfig(context)
                ?: run {
                    Log.e(TAG, "Cannot verify signature: public key not configured in strings.xml")
                    throw SignatureVerificationException.PublicKeyNotConfigured()
                }

        try {
            // Convert PEM to PublicKey
            val publicKey = createPublicKey(publicKeyPEM)

            // Calculate file hash
            val fileHashHex =
                HashUtils.calculateSHA256(bundleFile)
                    ?: run {
                        Log.e(TAG, "Failed to calculate file hash")
                        throw SignatureVerificationException.FileReadFailed()
                    }

            Log.d(TAG, "Calculated file hash: $fileHashHex")

            // Decode signature from base64
            val signatureBytes =
                try {
                    Base64.decode(signatureBase64, Base64.DEFAULT)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to decode signature from base64", e)
                    throw SignatureVerificationException.InvalidSignatureFormat()
                }

            // Convert hex fileHash to bytes
            val fileHashBytes = hexToByteArray(fileHashHex)

            // Verify signature using RSA-SHA256
            val verifier = Signature.getInstance("SHA256withRSA")
            verifier.initVerify(publicKey)
            verifier.update(fileHashBytes)
            val isValid = verifier.verify(signatureBytes)

            if (isValid) {
                Log.i(TAG, "✅ Signature verified successfully")
            } else {
                Log.e(TAG, "❌ Signature verification failed")
                throw SignatureVerificationException.SignatureVerificationFailed()
            }
        } catch (e: SignatureVerificationException) {
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "Signature verification error", e)
            throw SignatureVerificationException.SecurityFrameworkError(e)
        }
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
            val publicKeyBase64 =
                publicKeyPEM
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
     * @throws SignatureVerificationException.SignatureVerificationFailed if conversion fails
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
                data[i / 2] =
                    (
                        (Character.digit(hexString[i], 16) shl 4) +
                            Character.digit(hexString[i + 1], 16)
                    ).toByte()
                i += 2
            }
            return data
        } catch (e: Exception) {
            Log.e(TAG, "Failed to convert hex to byte array", e)
            throw SignatureVerificationException.InvalidSignatureFormat()
        }
    }
}
