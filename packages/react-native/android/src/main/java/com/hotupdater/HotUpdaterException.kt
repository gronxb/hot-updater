package com.hotupdater

/**
 * Exception class for Hot Updater errors
 * Matches error codes defined in packages/react-native/src/errors.ts
 */
class HotUpdaterException(
    val code: String,
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause) {
    companion object {
        // Parameter validation errors
        fun missingBundleId() =
            HotUpdaterException(
                "MISSING_BUNDLE_ID",
                "Missing or empty 'bundleId'",
            )

        fun invalidFileUrl() =
            HotUpdaterException(
                "INVALID_FILE_URL",
                "Invalid 'fileUrl' provided",
            )

        fun instanceNotFound(identifier: String) =
            HotUpdaterException(
                "INSTANCE_NOT_FOUND",
                "HotUpdater instance with identifier '$identifier' not found. Make sure to create the instance first.",
            )

        fun identifierMismatch(
            bundleUrlId: String?,
            updateBundleId: String?,
        ) = HotUpdaterException(
            "IDENTIFIER_MISMATCH",
            "Identifier mismatch: bundleURL uses '$bundleUrlId' but updateBundle received '$updateBundleId'",
        )

        // Bundle storage errors
        fun directoryCreationFailed() =
            HotUpdaterException(
                "DIRECTORY_CREATION_FAILED",
                "Failed to create bundle directory",
            )

        fun downloadFailed(cause: Throwable? = null) =
            HotUpdaterException(
                "DOWNLOAD_FAILED",
                "Failed to download bundle",
                cause,
            )

        fun incompleteDownload(
            expectedSize: Long,
            actualSize: Long,
        ) = HotUpdaterException(
            "INCOMPLETE_DOWNLOAD",
            "Download incomplete: received $actualSize bytes, expected $expectedSize bytes",
        )

        fun extractionFormatError(cause: Throwable? = null) =
            HotUpdaterException(
                "EXTRACTION_FORMAT_ERROR",
                "Invalid or corrupted bundle archive format",
                cause,
            )

        fun invalidBundle() =
            HotUpdaterException(
                "INVALID_BUNDLE",
                "Bundle missing required platform files (index.ios.bundle or index.android.bundle)",
            )

        fun insufficientDiskSpace(
            required: Long,
            available: Long,
        ) = HotUpdaterException(
            "INSUFFICIENT_DISK_SPACE",
            "Insufficient disk space: need $required bytes, available $available bytes",
        )

        fun signatureVerificationFailed(cause: Throwable? = null) =
            HotUpdaterException(
                "SIGNATURE_VERIFICATION_FAILED",
                "Bundle signature verification failed",
                cause,
            )

        fun moveOperationFailed() =
            HotUpdaterException(
                "MOVE_OPERATION_FAILED",
                "Failed to move bundle files",
            )

        fun bundleInCrashedHistory(bundleId: String) =
            HotUpdaterException(
                "BUNDLE_IN_CRASHED_HISTORY",
                "Bundle '$bundleId' is in crashed history and cannot be applied",
            )

        // Signature verification errors
        fun publicKeyNotConfigured() =
            HotUpdaterException(
                "PUBLIC_KEY_NOT_CONFIGURED",
                "Public key not configured for signature verification",
            )

        fun invalidPublicKeyFormat() =
            HotUpdaterException(
                "INVALID_PUBLIC_KEY_FORMAT",
                "Invalid public key format",
            )

        fun fileHashMismatch() =
            HotUpdaterException(
                "FILE_HASH_MISMATCH",
                "File hash verification failed",
            )

        fun fileReadFailed() =
            HotUpdaterException(
                "FILE_READ_FAILED",
                "Failed to read file for verification",
            )

        fun unsignedNotAllowed() =
            HotUpdaterException(
                "UNSIGNED_NOT_ALLOWED",
                "Unsigned bundles are not allowed",
            )

        fun securityFrameworkError(cause: Throwable? = null) =
            HotUpdaterException(
                "SECURITY_FRAMEWORK_ERROR",
                "Security framework error occurred",
                cause,
            )

        // Internal errors
        fun unknownError(cause: Throwable? = null) =
            HotUpdaterException(
                "UNKNOWN_ERROR",
                "An unknown error occurred",
                cause,
            )
    }
}
