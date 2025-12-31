/**
 * Utilities for handling signed file hashes in Hot Updater.
 *
 * The signed hash format uses a simple prefix to indicate signing:
 * - Signed: `sig:<base64_signature>`
 * - Unsigned: `<hex_hash>` (plain SHA256)
 *
 * Signature verification implicitly verifies hash integrity,
 * so we only need to store the signature for signed bundles.
 *
 * @module signedHashUtils
 */

/**
 * Prefix indicating a signed file hash.
 * @example "sig:MEUCIQDx..."
 */
export const SIGNED_HASH_PREFIX = "sig:";

/**
 * Custom error class for signed hash format errors.
 */
export class SignedHashFormatError extends Error {
  /**
   * Creates a new SignedHashFormatError.
   *
   * @param message - Description of the format error
   * @param input - The malformed input string that caused the error
   */
  constructor(
    message: string,
    public readonly input: string,
  ) {
    super(message);
    this.name = "SignedHashFormatError";
  }
}

/**
 * Creates a signed file hash from a signature.
 *
 * The format is: `sig:<base64_signature>`
 *
 * Note: The hash is not stored because signature verification
 * implicitly verifies the hash (the signature is computed over the hash).
 *
 * @param signature - The Base64-encoded RSA-SHA256 signature
 * @returns The signed file hash string
 * @throws {SignedHashFormatError} If the signature is empty
 *
 * @example
 * ```typescript
 * const signedHash = createSignedFileHash("MEUCIQDx...");
 * // Returns: "sig:MEUCIQDx..."
 * ```
 */
export function createSignedFileHash(signature: string): string {
  if (!signature || signature.trim().length === 0) {
    throw new SignedHashFormatError(
      "Invalid signature: signature cannot be empty",
      signature ?? "",
    );
  }

  return `${SIGNED_HASH_PREFIX}${signature}`;
}

/**
 * Checks whether a file hash string is a signed format.
 *
 * @param fileHash - The file hash string to check
 * @returns True if the hash starts with the signed format prefix
 *
 * @example
 * ```typescript
 * isSignedFileHash("sig:MEUCIQDx..."); // true
 * isSignedFileHash("abc123def456");    // false
 * isSignedFileHash("");                // false
 * ```
 */
export function isSignedFileHash(fileHash: string): boolean {
  return !!fileHash && fileHash.startsWith(SIGNED_HASH_PREFIX);
}

/**
 * Extracts the signature from a signed file hash.
 *
 * @param fileHash - The signed file hash string
 * @returns The Base64-encoded signature, or null if not a signed hash
 *
 * @example
 * ```typescript
 * extractSignature("sig:MEUCIQDx..."); // "MEUCIQDx..."
 * extractSignature("abc123def456");    // null
 * ```
 */
export function extractSignature(fileHash: string): string | null {
  if (!isSignedFileHash(fileHash)) {
    return null;
  }
  return fileHash.slice(SIGNED_HASH_PREFIX.length);
}
