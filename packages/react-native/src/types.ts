/**
 * Information about a signature verification failure.
 * This is a security-critical event that indicates the bundle
 * may have been tampered with or the public key is misconfigured.
 */
export interface SignatureVerificationFailure {
  /**
   * The bundle ID that failed verification.
   */
  bundleId: string;
  /**
   * Human-readable error message from the native layer.
   */
  message: string;
  /**
   * The underlying error object.
   */
  error: Error;
}

/**
 * Checks if an error is a signature verification failure.
 * Matches error messages from both iOS and Android native implementations.
 *
 * **IMPORTANT**: This function relies on specific error message patterns from native code.
 * If you change the error messages in the native implementations, update these patterns:
 * - iOS: `ios/HotUpdater/Internal/SignatureVerifier.swift` (SignatureVerificationError)
 * - Android: `android/src/main/java/com/hotupdater/SignatureVerifier.kt` (SignatureVerificationException)
 */
export function isSignatureVerificationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();

  // Match iOS SignatureVerificationError messages
  // Match Android SignatureVerificationException messages
  return (
    message.includes("signature verification") ||
    message.includes("public key not configured") ||
    message.includes("public key format is invalid") ||
    message.includes("signature format is invalid") ||
    message.includes("bundle may be corrupted or tampered")
  );
}

/**
 * Extracts signature verification failure details from an error.
 */
export function extractSignatureFailure(
  error: unknown,
  bundleId: string,
): SignatureVerificationFailure {
  const normalizedError =
    error instanceof Error ? error : new Error(String(error));

  return {
    bundleId,
    message: normalizedError.message,
    error: normalizedError,
  };
}
