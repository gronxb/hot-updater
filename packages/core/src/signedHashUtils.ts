/**
 * Utilities for handling signed file hashes in Hot Updater.
 *
 * The signed hash format combines a cryptographic signature with a SHA256 hash
 * to enable bundle integrity verification and authenticity checks.
 *
 * @module signedHashUtils
 */

/**
 * Prefix indicating the start of a signature in the combined format.
 * @example "sig:abc123..."
 */
export const SIGNED_HASH_PREFIX = "sig:";

/**
 * Prefix indicating the start of a SHA256 hash in the combined format.
 * @example "sha256:abc123..."
 */
export const SHA256_PREFIX = "sha256:";

/**
 * Separator between signature and hash components.
 * @example "sig:<signature>;sha256:<hash>"
 */
export const SIGNED_HASH_SEPARATOR = ";";

/**
 * Regular expression to validate hexadecimal hash strings.
 * Matches strings containing only hexadecimal characters (0-9, a-f, A-F).
 */
const HEX_HASH_REGEX = /^[a-fA-F0-9]+$/;

/**
 * Regular expression to parse the signed hash format.
 * Captures:
 * - Group 1: Base64-encoded signature
 * - Group 2: Hexadecimal SHA256 hash
 *
 * @example "sig:dGVzdA==;sha256:abc123def456"
 */
const SIGNED_FORMAT_REGEX = /^sig:([^;]+);sha256:([a-fA-F0-9]+)$/;

/**
 * Parsed representation of a file hash, which may or may not contain a signature.
 */
export interface ParsedFileHash {
  /**
   * The SHA256 hash of the file in hexadecimal format.
   */
  hash: string;
  /**
   * The Base64-encoded signature, or null if unsigned.
   */
  signature: string | null;
  /**
   * Whether the file hash contains an embedded signature.
   */
  isSigned: boolean;
}

/**
 * Custom error class for malformed signed hash format errors.
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
 * Validates that a string is a valid hexadecimal hash.
 *
 * @param hash - The string to validate
 * @returns True if the hash contains only valid hex characters, false otherwise
 */
function isValidHexHash(hash: string): boolean {
  return hash.length > 0 && HEX_HASH_REGEX.test(hash);
}

/**
 * Creates a combined signed file hash from a hash and signature.
 *
 * The combined format is: `sig:<base64_signature>;sha256:<hex_hash>`
 *
 * @param hash - The SHA256 hash in hexadecimal format
 * @param signature - The Base64-encoded RSA-SHA256 signature
 * @returns The combined signed hash string
 * @throws {SignedHashFormatError} If the hash is not valid hexadecimal
 *
 * @example
 * ```typescript
 * const signedHash = createSignedFileHash(
 *   "abc123def456...",
 *   "dGVzdHNpZ25hdHVyZQ=="
 * );
 * // Returns: "sig:dGVzdHNpZ25hdHVyZQ==;sha256:abc123def456..."
 * ```
 */
export function createSignedFileHash(hash: string, signature: string): string {
  if (!isValidHexHash(hash)) {
    throw new SignedHashFormatError(
      `Invalid hash format: hash must be hexadecimal, got "${hash.slice(0, 20)}${hash.length > 20 ? "..." : ""}"`,
      hash,
    );
  }

  if (!signature || signature.trim().length === 0) {
    throw new SignedHashFormatError(
      "Invalid signature: signature cannot be empty",
      signature,
    );
  }

  return `${SIGNED_HASH_PREFIX}${signature}${SIGNED_HASH_SEPARATOR}${SHA256_PREFIX}${hash}`;
}

/**
 * Parses a file hash string, extracting the hash and optional signature.
 *
 * Handles two formats:
 * 1. Signed format: `sig:<base64_signature>;sha256:<hex_hash>`
 * 2. Unsigned format: plain hexadecimal SHA256 hash (64 characters)
 *
 * @param fileHash - The file hash string to parse
 * @returns Parsed hash components with signature if present
 * @throws {SignedHashFormatError} If the format is invalid or malformed
 *
 * @example
 * ```typescript
 * // Signed hash
 * const signed = parseFileHash("sig:abc==;sha256:def123...");
 * // { hash: "def123...", signature: "abc==", isSigned: true }
 *
 * // Unsigned hash
 * const unsigned = parseFileHash("abc123def456...");
 * // { hash: "abc123def456...", signature: null, isSigned: false }
 * ```
 */
export function parseFileHash(fileHash: string): ParsedFileHash {
  if (!fileHash || fileHash.trim().length === 0) {
    throw new SignedHashFormatError(
      "Invalid file hash: cannot be empty",
      fileHash ?? "",
    );
  }

  const trimmed = fileHash.trim();

  // Check if it's the signed format
  if (trimmed.startsWith(SIGNED_HASH_PREFIX)) {
    const match = trimmed.match(SIGNED_FORMAT_REGEX);

    if (!match) {
      throw new SignedHashFormatError(
        `Malformed signed hash format. Expected "sig:<signature>;sha256:<hash>", got "${trimmed.slice(0, 50)}${trimmed.length > 50 ? "..." : ""}"`,
        trimmed,
      );
    }

    const [, signature, hash] = match;

    return {
      hash,
      signature,
      isSigned: true,
    };
  }

  // It's a plain hash - validate it's hexadecimal
  if (!isValidHexHash(trimmed)) {
    throw new SignedHashFormatError(
      `Invalid hash format: expected hexadecimal string, got "${trimmed.slice(0, 20)}${trimmed.length > 20 ? "..." : ""}"`,
      trimmed,
    );
  }

  return {
    hash: trimmed,
    signature: null,
    isSigned: false,
  };
}

/**
 * Checks whether a file hash string contains an embedded signature.
 *
 * This is a quick check that does not validate the format.
 * For full validation, use `parseFileHash()`.
 *
 * @param fileHash - The file hash string to check
 * @returns True if the hash starts with the signed format prefix
 *
 * @example
 * ```typescript
 * isSignedFileHash("sig:abc;sha256:def"); // true
 * isSignedFileHash("abc123def456");       // false
 * isSignedFileHash("");                   // false
 * ```
 */
export function isSignedFileHash(fileHash: string): boolean {
  return !!fileHash && fileHash.startsWith(SIGNED_HASH_PREFIX);
}

/**
 * Safely parses a file hash string, returning null on errors instead of throwing.
 *
 * This is useful when handling potentially invalid input where errors should
 * be handled gracefully rather than causing exceptions.
 *
 * @param fileHash - The file hash string to parse, or null
 * @returns Parsed hash components if valid, null otherwise
 *
 * @example
 * ```typescript
 * const result = parseFileHashSafe("sig:abc;sha256:def");
 * if (result) {
 *   console.log(result.hash);
 * } else {
 *   console.log("Invalid hash format");
 * }
 *
 * parseFileHashSafe(null);      // null
 * parseFileHashSafe("");        // null
 * parseFileHashSafe("invalid"); // null
 * ```
 */
export function parseFileHashSafe(
  fileHash: string | null | undefined,
): ParsedFileHash | null {
  if (!fileHash) {
    return null;
  }

  try {
    return parseFileHash(fileHash);
  } catch {
    return null;
  }
}
