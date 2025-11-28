import Foundation
import Security

/// Prefix for signed file hash format.
private let SIGNED_HASH_PREFIX = "sig:"

/// Error types for signature verification failures.
///
/// **IMPORTANT**: The error messages in `errorUserInfo` are used by the JavaScript layer
/// (`packages/react-native/src/types.ts`) to detect signature verification failures.
/// If you change these messages, update `isSignatureVerificationError()` in types.ts accordingly.
public enum SignatureVerificationError: Error, CustomNSError {
    case publicKeyNotConfigured
    case invalidPublicKeyFormat
    case invalidSignatureFormat
    case verificationFailed
    case hashMismatch
    case hashCalculationFailed
    case unsignedNotAllowed
    case securityFrameworkError(OSStatus)

    // CustomNSError protocol implementation
    public static var errorDomain: String {
        return "com.hotupdater.SignatureVerificationError"
    }

    public var errorCode: Int {
        switch self {
        case .publicKeyNotConfigured: return 2001
        case .invalidPublicKeyFormat: return 2002
        case .invalidSignatureFormat: return 2003
        case .verificationFailed: return 2004
        case .hashMismatch: return 2005
        case .hashCalculationFailed: return 2006
        case .unsignedNotAllowed: return 2007
        case .securityFrameworkError: return 2099
        }
    }

    public var errorUserInfo: [String: Any] {
        var userInfo: [String: Any] = [:]

        switch self {
        case .publicKeyNotConfigured:
            userInfo[NSLocalizedDescriptionKey] = "Public key not configured for signature verification"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "Add HOT_UPDATER_PUBLIC_KEY to Info.plist with your RSA public key"

        case .invalidPublicKeyFormat:
            userInfo[NSLocalizedDescriptionKey] = "Public key format is invalid"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "Ensure the public key is in PEM format (BEGIN PUBLIC KEY)"

        case .invalidSignatureFormat:
            userInfo[NSLocalizedDescriptionKey] = "Signature format is invalid"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "The signature must be base64-encoded"

        case .verificationFailed:
            userInfo[NSLocalizedDescriptionKey] = "Bundle signature verification failed"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "The bundle may be corrupted or tampered with. Rejecting update for security"

        case .hashMismatch:
            userInfo[NSLocalizedDescriptionKey] = "Bundle hash verification failed"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "The bundle file hash does not match. File may be corrupted"

        case .hashCalculationFailed:
            userInfo[NSLocalizedDescriptionKey] = "Failed to calculate file hash"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "Could not read file for hash verification"

        case .unsignedNotAllowed:
            userInfo[NSLocalizedDescriptionKey] = "Unsigned bundle not allowed when signing is enabled"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "Public key is configured but bundle is not signed. Rejecting update"

        case .securityFrameworkError(let status):
            userInfo[NSLocalizedDescriptionKey] = "Security framework error during verification (OSStatus: \(status))"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "Check public key format and signature data"
        }

        return userInfo
    }
}

/**
 * Service for verifying bundle integrity through hash or RSA-SHA256 signature verification.
 * Uses iOS Security framework for cryptographic operations.
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
public class SignatureVerifier {

    /**
     * Reads public key from Info.plist configuration.
     * @return Public key PEM string or nil if not configured
     */
    private static func getPublicKeyFromConfig() -> String? {
        guard let publicKeyPEM = Bundle.main.object(forInfoDictionaryKey: "HOT_UPDATER_PUBLIC_KEY") as? String else {
            NSLog("[SignatureVerifier] HOT_UPDATER_PUBLIC_KEY not found in Info.plist")
            return nil
        }
        return publicKeyPEM
    }

    /**
     * Checks if signing is enabled (public key is configured).
     * @return true if public key is configured
     */
    public static func isSigningEnabled() -> Bool {
        return getPublicKeyFromConfig() != nil
    }

    /**
     * Checks if fileHash is in signed format (starts with "sig:").
     * @param fileHash The file hash string to check
     * @return true if signed format
     */
    public static func isSignedFormat(_ fileHash: String?) -> Bool {
        guard let hash = fileHash else { return false }
        return hash.hasPrefix(SIGNED_HASH_PREFIX)
    }

    /**
     * Extracts signature from signed format fileHash.
     * @param fileHash The signed file hash (sig:<signature>)
     * @return Base64-encoded signature or nil if not signed format
     */
    public static func extractSignature(_ fileHash: String?) -> String? {
        guard let hash = fileHash, isSignedFormat(hash) else { return nil }
        return String(hash.dropFirst(SIGNED_HASH_PREFIX.count))
    }

    /**
     * Verifies bundle integrity based on fileHash format.
     * Determines verification mode by checking for "sig:" prefix.
     *
     * @param fileURL URL of the bundle file to verify
     * @param fileHash Combined hash string (sig:<signature> or <hex_hash>)
     * @return Result indicating verification success or failure with error
     */
    public static func verifyBundle(fileURL: URL, fileHash: String?) -> Result<Void, SignatureVerificationError> {
        let signingEnabled = isSigningEnabled()

        // Rule: null/empty fileHash → REJECT
        guard let hash = fileHash, !hash.isEmpty else {
            NSLog("[SignatureVerifier] fileHash is null or empty. Rejecting update.")
            return .failure(.verificationFailed)
        }

        if isSignedFormat(hash) {
            // Signed format: sig:<signature>
            guard let signature = extractSignature(hash) else {
                NSLog("[SignatureVerifier] Failed to extract signature from fileHash")
                return .failure(.invalidSignatureFormat)
            }

            // Rule: sig:... + public key NOT configured → REJECT
            guard signingEnabled else {
                NSLog("[SignatureVerifier] Signed bundle but public key not configured. Cannot verify.")
                return .failure(.publicKeyNotConfigured)
            }

            // Rule: sig:... + public key configured → verify signature
            return verifySignature(fileURL: fileURL, signatureBase64: signature)
        } else {
            // Unsigned format: <hex_hash>

            // Rule: <hash> + public key configured → REJECT
            if signingEnabled {
                NSLog("[SignatureVerifier] Unsigned bundle not allowed when signing is enabled. Rejecting.")
                return .failure(.unsignedNotAllowed)
            }

            // Rule: <hash> + public key NOT configured → verify hash
            return verifyHash(fileURL: fileURL, expectedHash: hash)
        }
    }

    /**
     * Verifies SHA256 hash of a file.
     * @param fileURL URL of the file to verify
     * @param expectedHash Expected SHA256 hash (hex string)
     * @return Result indicating verification success or failure
     */
    public static func verifyHash(fileURL: URL, expectedHash: String) -> Result<Void, SignatureVerificationError> {
        NSLog("[SignatureVerifier] Verifying hash for file: \(fileURL.lastPathComponent)")

        guard HashUtils.verifyHash(fileURL: fileURL, expectedHash: expectedHash) else {
            NSLog("[SignatureVerifier] Hash mismatch!")
            return .failure(.hashMismatch)
        }

        NSLog("[SignatureVerifier] ✅ Hash verified successfully")
        return .success(())
    }

    /**
     * Verifies RSA-SHA256 signature of a file.
     * Calculates the file hash internally and verifies the signature.
     *
     * @param fileURL URL of the file to verify
     * @param signatureBase64 Base64-encoded RSA-SHA256 signature
     * @return Result indicating verification success or failure with error
     */
    public static func verifySignature(fileURL: URL, signatureBase64: String) -> Result<Void, SignatureVerificationError> {
        NSLog("[SignatureVerifier] Verifying signature for file: \(fileURL.lastPathComponent)")

        // Get public key from config
        guard let publicKeyPEM = getPublicKeyFromConfig() else {
            NSLog("[SignatureVerifier] Cannot verify signature: public key not configured in Info.plist")
            return .failure(.publicKeyNotConfigured)
        }

        // Convert PEM to SecKey
        let publicKeyResult = createPublicKey(from: publicKeyPEM)
        guard case .success(let publicKey) = publicKeyResult else {
            if case .failure(let error) = publicKeyResult {
                return .failure(error)
            }
            return .failure(.invalidPublicKeyFormat)
        }

        // Calculate file hash
        guard let fileHashHex = HashUtils.calculateSHA256(fileURL: fileURL) else {
            NSLog("[SignatureVerifier] Failed to calculate file hash")
            return .failure(.hashCalculationFailed)
        }

        NSLog("[SignatureVerifier] Calculated file hash: \(fileHashHex)")

        // Decode signature from base64
        guard let signatureData = Data(base64Encoded: signatureBase64) else {
            NSLog("[SignatureVerifier] Failed to decode signature from base64")
            return .failure(.invalidSignatureFormat)
        }

        // Convert hex fileHash to data
        guard let fileHashData = dataFromHexString(fileHashHex) else {
            NSLog("[SignatureVerifier] Failed to convert fileHash from hex")
            return .failure(.invalidSignatureFormat)
        }

        // Verify signature
        let algorithm: SecKeyAlgorithm = .rsaSignatureMessagePKCS1v15SHA256

        guard SecKeyIsAlgorithmSupported(publicKey, .verify, algorithm) else {
            NSLog("[SignatureVerifier] RSA-SHA256 algorithm not supported")
            return .failure(.securityFrameworkError(-1))
        }

        var error: Unmanaged<CFError>?
        let verified = SecKeyVerifySignature(
            publicKey,
            algorithm,
            fileHashData as CFData,
            signatureData as CFData,
            &error
        )

        if let err = error?.takeRetainedValue() {
            NSLog("[SignatureVerifier] Verification failed: \(err)")
            return .failure(.verificationFailed)
        }

        if verified {
            NSLog("[SignatureVerifier] ✅ Signature verified successfully")
            return .success(())
        } else {
            NSLog("[SignatureVerifier] ❌ Signature verification failed")
            return .failure(.verificationFailed)
        }
    }

    /**
     * Converts PEM-formatted public key to SecKey.
     * @param publicKeyPEM Public key in PEM format
     * @return SecKey or error
     */
    private static func createPublicKey(from publicKeyPEM: String) -> Result<SecKey, SignatureVerificationError> {
        // Remove PEM headers/footers and whitespace
        var keyString = publicKeyPEM
            .replacingOccurrences(of: "-----BEGIN PUBLIC KEY-----", with: "")
            .replacingOccurrences(of: "-----END PUBLIC KEY-----", with: "")
            .replacingOccurrences(of: "\\n", with: "")
            .replacingOccurrences(of: "\n", with: "")
            .replacingOccurrences(of: " ", with: "")

        // Decode base64
        guard let keyData = Data(base64Encoded: keyString) else {
            NSLog("[SignatureVerifier] Failed to decode public key from base64")
            return .failure(.invalidPublicKeyFormat)
        }

        // SecKeyCreateWithData auto-detects key size from SPKI-formatted key data.
        // This supports any valid RSA key size (2048, 3072, 4096-bit, etc.)
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass as String: kSecAttrKeyClassPublic
        ]

        var error: Unmanaged<CFError>?
        guard let secKey = SecKeyCreateWithData(keyData as CFData, attributes as CFDictionary, &error) else {
            if let err = error?.takeRetainedValue() {
                NSLog("[SignatureVerifier] SecKeyCreateWithData failed: \(err)")
            }
            return .failure(.invalidPublicKeyFormat)
        }

        return .success(secKey)
    }

    /**
     * Converts hex string to Data.
     * @param hexString Hex-encoded string
     * @return Data or nil if invalid format
     */
    private static func dataFromHexString(_ hexString: String) -> Data? {
        var data = Data(capacity: hexString.count / 2)

        var index = hexString.startIndex
        while index < hexString.endIndex {
            let nextIndex = hexString.index(index, offsetBy: 2)
            guard nextIndex <= hexString.endIndex else { return nil }

            let byteString = hexString[index..<nextIndex]
            guard let byte = UInt8(byteString, radix: 16) else { return nil }

            data.append(byte)
            index = nextIndex
        }

        return data
    }
}
