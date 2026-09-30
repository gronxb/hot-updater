package com.hotupdater

import java.io.IOException
import java.io.InterruptedIOException
import java.net.MalformedURLException
import java.net.SocketException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/**
 * Where an update failed: [DOWNLOAD] covers transferring and verifying the
 * update's files, [INSTALL] producing the bundle on disk.
 * Values match `UpdateErrorStage` in packages/react-native/src/clientPlugin.ts.
 */
enum class UpdateFailureStage(
    val value: String,
) {
    DOWNLOAD("download"),
    INSTALL("install"),
}

/**
 * Why an update failed.
 * Values match `UpdateErrorReason` in packages/react-native/src/clientPlugin.ts.
 */
enum class UpdateFailureReason(
    val value: String,
) {
    NETWORK("network"),
    HTTP("http"),
    INVALID_RESPONSE("invalid_response"),
    HASH_MISMATCH("hash_mismatch"),
    SIGNATURE("signature"),
    PATCH("patch"),
    EXTRACT("extract"),
    STORAGE("storage"),
    UNKNOWN("unknown"),
}

/** What was being fetched or applied when an update failed. */
enum class UpdateFailureResource(
    val value: String,
) {
    MANIFEST("manifest"),
    FILE("file"),
    PATCH("patch"),
    ARCHIVE("archive"),
}

/** Why no HTTP response arrived, for a [UpdateFailureReason.NETWORK] failure. */
enum class UpdateFailureTransport(
    val value: String,
) {
    TIMEOUT("timeout"),
    DNS("dns"),
    TLS("tls"),
    CONNECTION("connection"),
    OFFLINE("offline"),
    CANCELLED("cancelled"),
}

/**
 * The classification an `updateBundle` rejection carries as `userInfo`.
 * [httpStatus] and [originCode] are reported only for
 * [UpdateFailureReason.HTTP], and [transport] only for
 * [UpdateFailureReason.NETWORK].
 */
data class UpdateFailure(
    val stage: UpdateFailureStage,
    val reason: UpdateFailureReason,
    val httpStatus: Int? = null,
    val resource: UpdateFailureResource? = null,
    val transport: UpdateFailureTransport? = null,
    /** The storage origin's XML error `<Code>`, such as `AccessDenied`. */
    val originCode: String? = null,
) {
    /**
     * The rejection's `userInfo`:
     * `{ stage, reason, resource?, httpStatus?, transport?, originCode? }`.
     */
    fun toUserInfo(): Map<String, Any> =
        buildMap {
            put("stage", stage.value)
            put("reason", reason.value)
            resource?.let { put("resource", it.value) }
            if (reason == UpdateFailureReason.HTTP) {
                httpStatus?.let { put("httpStatus", it) }
                originCode?.let { put("originCode", it) }
            }
            if (reason == UpdateFailureReason.NETWORK) {
                transport?.let { put("transport", it.value) }
            }
        }

    companion object {
        fun download(reason: UpdateFailureReason) = UpdateFailure(UpdateFailureStage.DOWNLOAD, reason)

        fun install(reason: UpdateFailureReason) = UpdateFailure(UpdateFailureStage.INSTALL, reason)

        fun http(
            status: Int,
            originCode: String? = null,
        ) = UpdateFailure(UpdateFailureStage.DOWNLOAD, UpdateFailureReason.HTTP, status, originCode = originCode)

        /**
         * Classifies the error a download returned. OkHttp rejects a URL it
         * cannot request with IllegalArgumentException, an invalid response.
         * [isOffline] is asked only after a failed host lookup.
         */
        fun ofDownloadError(
            error: Throwable?,
            isOffline: () -> Boolean = { false },
        ): UpdateFailure =
            when (error) {
                is HttpStatusException -> {
                    http(error.statusCode, error.originCode)
                }

                is LocalStorageException -> {
                    install(UpdateFailureReason.STORAGE)
                }

                is MalformedURLException -> {
                    download(UpdateFailureReason.INVALID_RESPONSE)
                }

                // The body ended early; the connection itself did not fail.
                is IncompleteDownloadException -> {
                    download(UpdateFailureReason.NETWORK)
                }

                is IOException -> {
                    UpdateFailure(
                        UpdateFailureStage.DOWNLOAD,
                        UpdateFailureReason.NETWORK,
                        transport = transportOf(error, isOffline),
                    )
                }

                is IllegalArgumentException -> {
                    download(UpdateFailureReason.INVALID_RESPONSE)
                }

                else -> {
                    download(UpdateFailureReason.UNKNOWN)
                }
            }

        /**
         * Why a request got no response, or null when the error does not say.
         * An [InterruptedIOException] is a socket or OkHttp call timeout, a
         * [SocketException] a refused, unreachable, or reset connection, and
         * OkHttp reports a canceled call as an IOException "Canceled".
         */
        private fun transportOf(
            error: IOException,
            isOffline: () -> Boolean,
        ): UpdateFailureTransport? =
            when {
                error is SSLException -> UpdateFailureTransport.TLS
                error is InterruptedIOException -> UpdateFailureTransport.TIMEOUT
                error is UnknownHostException -> if (isOffline()) UpdateFailureTransport.OFFLINE else UpdateFailureTransport.DNS
                error is SocketException -> UpdateFailureTransport.CONNECTION
                error.message == "Canceled" -> UpdateFailureTransport.CANCELLED
                else -> null
            }

        /** Classifies a failed hash or signature check of a downloaded file. */
        fun ofVerificationError(error: Throwable?): UpdateFailure =
            when (error) {
                is SignatureVerificationException.FileHashMismatch -> download(UpdateFailureReason.HASH_MISMATCH)
                is SignatureVerificationException.FileReadFailed -> install(UpdateFailureReason.STORAGE)
                else -> download(UpdateFailureReason.SIGNATURE)
            }

        /**
         * Classifies an error the pipeline did not anticipate: a malformed URL
         * is an invalid response, any other I/O error a local storage failure,
         * and anything else unknown in [stage].
         */
        fun ofUnexpectedError(
            error: Throwable,
            stage: UpdateFailureStage,
        ): UpdateFailure =
            when (error) {
                is MalformedURLException -> download(UpdateFailureReason.INVALID_RESPONSE)
                is IOException -> install(UpdateFailureReason.STORAGE)
                else -> UpdateFailure(stage, UpdateFailureReason.UNKNOWN)
            }
    }
}

/**
 * The Release catalog selection changed while its bundle was being installed.
 * The update was superseded, so this rejection is not an update failure.
 */
class StaleReleaseSelectionException : IllegalStateException("Release catalog selection is stale")

/**
 * Exception class for Hot Updater errors
 * Matches error codes defined in packages/react-native/src/errors.ts
 *
 * [failure] classifies an update failure for JS. It is null for a rejection
 * that is not an update failure, such as a bundle in the crashed history.
 */
class HotUpdaterException(
    val code: String,
    message: String,
    cause: Throwable? = null,
    val failure: UpdateFailure? = null,
) : Exception(message, cause) {
    /**
     * This failure with [resource] as what was being fetched or applied,
     * unless it already names one or is not an update failure.
     */
    fun withResource(resource: UpdateFailureResource?): HotUpdaterException {
        val failure = failure
        if (resource == null || failure == null || failure.resource != null) {
            return this
        }
        return HotUpdaterException(code, message.orEmpty(), cause, failure.copy(resource = resource)).also {
            it.stackTrace = stackTrace
        }
    }

    companion object {
        private val invalidResponse = UpdateFailure.download(UpdateFailureReason.INVALID_RESPONSE)
        private val signatureFailure = UpdateFailure.download(UpdateFailureReason.SIGNATURE)
        private val storageFailure = UpdateFailure.install(UpdateFailureReason.STORAGE)

        // Parameter validation errors
        fun missingBundleId() =
            HotUpdaterException(
                "MISSING_BUNDLE_ID",
                "Missing or empty 'bundleId'",
                failure = invalidResponse,
            )

        fun invalidManifestParams() =
            HotUpdaterException(
                "INVALID_MANIFEST",
                "Manifest URL, hash, and assets are required",
                failure = invalidResponse.copy(resource = UpdateFailureResource.MANIFEST),
            )

        fun invalidFileUrl(
            parameter: String,
            url: String,
            resource: UpdateFailureResource,
        ) = HotUpdaterException(
            "INVALID_FILE_URL",
            "Invalid '$parameter' provided: $url",
            failure = invalidResponse.copy(resource = resource),
        )

        // Bundle storage errors
        fun directoryCreationFailed() =
            HotUpdaterException(
                "DIRECTORY_CREATION_FAILED",
                "Failed to create bundle directory",
                failure = storageFailure,
            )

        fun downloadFailed(
            cause: Throwable? = null,
            failure: UpdateFailure = UpdateFailure.ofDownloadError(cause),
        ) = HotUpdaterException(
            "DOWNLOAD_FAILED",
            "Failed to download bundle",
            cause,
            failure,
        )

        fun incompleteDownload(
            expectedSize: Long,
            actualSize: Long,
        ) = HotUpdaterException(
            "INCOMPLETE_DOWNLOAD",
            "Download incomplete: received $actualSize bytes, expected $expectedSize bytes",
            failure = UpdateFailure.download(UpdateFailureReason.NETWORK),
        )

        fun invalidBundle() =
            HotUpdaterException(
                "INVALID_BUNDLE",
                "Bundle missing required platform files (index.ios.bundle or index.android.bundle)",
                failure = invalidResponse,
            )

        fun insufficientDiskSpace(
            required: Long,
            available: Long,
        ) = HotUpdaterException(
            "INSUFFICIENT_DISK_SPACE",
            "Insufficient disk space: need $required bytes, available $available bytes",
            failure = storageFailure,
        )

        fun signatureVerificationFailed(
            cause: Throwable? = null,
            failure: UpdateFailure = UpdateFailure.ofVerificationError(cause),
        ) = HotUpdaterException(
            "SIGNATURE_VERIFICATION_FAILED",
            "Bundle signature verification failed",
            cause,
            failure,
        )

        fun moveOperationFailed() =
            HotUpdaterException(
                "MOVE_OPERATION_FAILED",
                "Failed to move bundle files",
                failure = storageFailure,
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
                failure = signatureFailure,
            )

        fun invalidPublicKeyFormat() =
            HotUpdaterException(
                "INVALID_PUBLIC_KEY_FORMAT",
                "Invalid public key format",
                failure = signatureFailure,
            )

        fun fileHashMismatch() =
            HotUpdaterException(
                "FILE_HASH_MISMATCH",
                "File hash verification failed",
                failure = UpdateFailure.download(UpdateFailureReason.HASH_MISMATCH),
            )

        fun fileReadFailed() =
            HotUpdaterException(
                "FILE_READ_FAILED",
                "Failed to read file for verification",
                failure = storageFailure,
            )

        fun unsignedNotAllowed() =
            HotUpdaterException(
                "UNSIGNED_NOT_ALLOWED",
                "Unsigned bundles are not allowed",
                failure = signatureFailure,
            )

        fun securityFrameworkError(cause: Throwable? = null) =
            HotUpdaterException(
                "SECURITY_FRAMEWORK_ERROR",
                "Security framework error occurred",
                cause,
                failure = signatureFailure,
            )

        // Internal errors
        fun unknownError(cause: Throwable? = null) =
            HotUpdaterException(
                "UNKNOWN_ERROR",
                "An unknown error occurred",
                cause,
            )

        /**
         * A local storage failure while producing the bundle. It keeps the
         * `UNKNOWN_ERROR` code these failures have always been rejected with.
         */
        fun storageFailed(message: String) =
            HotUpdaterException(
                "UNKNOWN_ERROR",
                message,
                failure = storageFailure,
            )

        /**
         * Wraps an error the update pipeline did not anticipate in the
         * `UNKNOWN_ERROR` rejection it has always produced, adding [failure].
         */
        fun unexpected(
            cause: Throwable,
            failure: UpdateFailure,
        ) = HotUpdaterException(
            "UNKNOWN_ERROR",
            cause.message ?: "An unknown error occurred",
            cause,
            failure,
        )
    }
}
