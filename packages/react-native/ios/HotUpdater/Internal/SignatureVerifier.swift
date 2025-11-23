import Foundation
import Security

public enum SignatureVerificationError: Error, CustomNSError {
    case publicKeyNotConfigured
    case invalidPublicKeyFormat
    case invalidSignatureFormat
    case verificationFailed
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
        case .securityFrameworkError: return 2005
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

        case .securityFrameworkError(let status):
            userInfo[NSLocalizedDescriptionKey] = "Security framework error during verification (OSStatus: \(status))"
            userInfo[NSLocalizedRecoverySuggestionErrorKey] = "Check public key format and signature data"
        }

        return userInfo
    }
}

/**
 * Service for verifying RSA-SHA256 signatures of bundle fileHash.
 * Uses iOS Security framework for cryptographic operations.
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
     * Verifies RSA-SHA256 signature of fileHash.
     * @param fileHash SHA256 hash of bundle file (hex string)
     * @param signatureBase64 Base64-encoded RSA-SHA256 signature
     * @return Result indicating verification success or failure with error
     */
    public static func verifySignature(fileHash: String, signatureBase64: String?) -> Result<Void, SignatureVerificationError> {
        // If no signature provided, check if verification is required
        guard let signature = signatureBase64 else {
            // Check if public key is configured (signing enabled)
            if getPublicKeyFromConfig() != nil {
                NSLog("[SignatureVerifier] Signature missing but verification is configured. Rejecting update.")
                return .failure(.verificationFailed)
            }
            // No signature and no public key = signing not enabled, allow update
            NSLog("[SignatureVerifier] Signature verification not configured. Skipping.")
            return .success(())
        }

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

        // Decode signature from base64
        guard let signatureData = Data(base64Encoded: signature) else {
            NSLog("[SignatureVerifier] Failed to decode signature from base64")
            return .failure(.invalidSignatureFormat)
        }

        // Convert hex fileHash to data
        guard let fileHashData = dataFromHexString(fileHash) else {
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
