/**
 * Hot Updater Error Codes
 *
 * This file defines all possible error codes that can be thrown by the native
 * updateBundle function. These error codes are shared across iOS and Android
 * implementations to ensure consistent error handling.
 *
 * Error Classification:
 * - Parameter Validation: Invalid or missing function parameters
 * - Bundle Storage: Errors during download, extraction, and storage
 * - Signature Verification: Cryptographic verification failures (collapsed to a single public code)
 * - Internal: Platform-specific or unexpected errors
 *
 * Retryability:
 * - Retryable: DOWNLOAD_FAILED, INCOMPLETE_DOWNLOAD
 * - Non-retryable: Most validation and verification errors
 */

export enum HotUpdaterErrorCode {
  // ==================== Parameter Validation Errors ====================

  /**
   * Bundle ID is missing or empty.
   * Thrown when bundleId parameter is null, undefined, or empty string.
   * @retryable false
   */
  MISSING_BUNDLE_ID = "MISSING_BUNDLE_ID",

  /**
   * File URL is invalid or malformed.
   * Thrown when fileUrl parameter cannot be parsed as a valid URL.
   * @retryable false
   */
  INVALID_FILE_URL = "INVALID_FILE_URL",

  // ==================== Bundle Storage Errors ====================

  /**
   * Failed to create required directory for bundle storage.
   * Thrown when bundle directory creation fails due to permissions or disk errors.
   * @retryable false - Usually indicates permissions or filesystem corruption
   */
  DIRECTORY_CREATION_FAILED = "DIRECTORY_CREATION_FAILED",

  /**
   * Bundle download failed.
   * Covers network errors, HTTP errors (4xx/5xx), timeouts, and connection issues.
   * Check error message for specific cause (network, HTTP status code, etc.).
   * @retryable true - Network issues are often transient
   */
  DOWNLOAD_FAILED = "DOWNLOAD_FAILED",

  /**
   * Download incomplete - received size doesn't match expected size.
   * Thrown when downloaded file size doesn't match Content-Length header.
   * Error message includes both expected and actual byte counts.
   * @retryable true - Download may succeed on retry
   */
  INCOMPLETE_DOWNLOAD = "INCOMPLETE_DOWNLOAD",

  /**
   * Bundle archive format is invalid or corrupted.
   * Thrown when ZIP file has wrong magic bytes, invalid structure, or unsupported format.
   * Also thrown for path traversal attempts during extraction.
   * @retryable false - Indicates corrupted or malicious bundle
   */
  EXTRACTION_FORMAT_ERROR = "EXTRACTION_FORMAT_ERROR",

  /**
   * Bundle missing required platform files.
   * Thrown when extracted bundle doesn't contain index.android.bundle (Android)
   * or main.jsbundle (iOS).
   * @retryable false - Indicates incorrectly built bundle
   */
  INVALID_BUNDLE = "INVALID_BUNDLE",

  /**
   * Insufficient disk space for bundle download and extraction.
   * Thrown when available disk space is less than required (file size * 2).
   * Error message includes required and available bytes.
   * @retryable false - User must free up disk space
   */
  INSUFFICIENT_DISK_SPACE = "INSUFFICIENT_DISK_SPACE",

  /**
   * Bundle signature verification failed (general).
   * Thrown when cryptographic signature verification fails.
   * All signature/hash sub-errors are collapsed into this public code.
   * @retryable false - Indicates tampered or incorrectly signed bundle
   */
  SIGNATURE_VERIFICATION_FAILED = "SIGNATURE_VERIFICATION_FAILED",

  /**
   * Failed to move bundle to final location.
   * Thrown when atomic move from temp directory to final directory fails.
   * iOS: Thrown if move operation fails.
   * Android: Thrown if rename, move, AND copy all fail.
   * @retryable false - Usually indicates filesystem corruption or permissions
   */
  MOVE_OPERATION_FAILED = "MOVE_OPERATION_FAILED",

  // ==================== Signature Verification Errors ====================
  // (Collapsed into SIGNATURE_VERIFICATION_FAILED)

  // ==================== Internal Errors ====================

  /**
   * Internal error: self deallocated during update (iOS only).
   * Thrown when the native object is deallocated mid-operation.
   * iOS-specific due to manual memory management (ARC).
   * Not applicable to Android (uses garbage collection).
   * @platform iOS
   * @retryable false - Memory management issue
   */
  SELF_DEALLOCATED = "SELF_DEALLOCATED",

  /**
   * An unknown or unexpected error occurred.
   * Catch-all for errors that don't fit other categories.
   * Check error message for details.
   * @retryable unknown - Depends on underlying cause
   */
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

/**
 * Type guard to check if an error is a HotUpdaterError
 */
export function isHotUpdaterError(
  error: unknown,
): error is { code: HotUpdaterErrorCode; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    Object.values(HotUpdaterErrorCode).includes(
      error.code as HotUpdaterErrorCode,
    )
  );
}

/**
 * Base error class for Hot Updater
 */
export class HotUpdaterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HotUpdaterError";
  }
}
