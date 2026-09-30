package com.hotupdater

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.MalformedURLException
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException

class HotUpdaterExceptionTest {
    private val invalidResponse = UpdateFailure.download(UpdateFailureReason.INVALID_RESPONSE)
    private val network = UpdateFailure.download(UpdateFailureReason.NETWORK)
    private val signature = UpdateFailure.download(UpdateFailureReason.SIGNATURE)
    private val storage = UpdateFailure.install(UpdateFailureReason.STORAGE)

    @Test
    fun `enum values match the JS contract`() {
        assertEquals(listOf("download", "install"), UpdateFailureStage.entries.map { it.value })
        assertEquals(
            listOf(
                "network",
                "http",
                "invalid_response",
                "hash_mismatch",
                "signature",
                "patch",
                "extract",
                "storage",
                "unknown",
            ),
            UpdateFailureReason.entries.map { it.value },
        )
        assertEquals(listOf("manifest", "file", "patch", "archive"), UpdateFailureResource.entries.map { it.value })
        assertEquals(
            listOf("timeout", "dns", "tls", "connection", "offline", "cancelled"),
            UpdateFailureTransport.entries.map { it.value },
        )
    }

    @Test
    fun `userInfo carries each optional key only with its reason`() {
        assertEquals(
            mapOf("stage" to "download", "reason" to "http", "httpStatus" to 404),
            UpdateFailure.http(404).toUserInfo(),
        )
        assertEquals(
            mapOf(
                "stage" to "download",
                "reason" to "http",
                "resource" to "manifest",
                "httpStatus" to 403,
                "originCode" to "AccessDenied",
            ),
            UpdateFailure.http(403, originCode = "AccessDenied").copy(resource = UpdateFailureResource.MANIFEST).toUserInfo(),
        )
        assertEquals(mapOf("stage" to "install", "reason" to "storage"), storage.toUserInfo())
        assertEquals(
            mapOf("stage" to "download", "reason" to "network", "resource" to "file", "transport" to "timeout"),
            UpdateFailure(
                UpdateFailureStage.DOWNLOAD,
                UpdateFailureReason.NETWORK,
                httpStatus = 500,
                resource = UpdateFailureResource.FILE,
                transport = UpdateFailureTransport.TIMEOUT,
                originCode = "Ignored",
            ).toUserInfo(),
        )
        assertEquals(
            mapOf("stage" to "download", "reason" to "http", "httpStatus" to 502),
            UpdateFailure.http(502).copy(transport = UpdateFailureTransport.DNS).toUserInfo(),
        )
    }

    @Test
    fun `download errors are classified by their cause`() {
        val cases =
            listOf(
                HttpStatusException(403, "Forbidden") to UpdateFailure.http(403),
                HttpStatusException(404, "Not Found", originCode = "NoSuchKey") to UpdateFailure.http(404, originCode = "NoSuchKey"),
                UnknownHostException("updates.example.com") to network.copy(transport = UpdateFailureTransport.DNS),
                SocketTimeoutException("connect timed out") to network.copy(transport = UpdateFailureTransport.TIMEOUT),
                InterruptedIOException("timeout") to network.copy(transport = UpdateFailureTransport.TIMEOUT),
                SSLHandshakeException("Chain validation failed") to network.copy(transport = UpdateFailureTransport.TLS),
                SSLPeerUnverifiedException("Hostname not verified") to network.copy(transport = UpdateFailureTransport.TLS),
                ConnectException("Connection refused") to network.copy(transport = UpdateFailureTransport.CONNECTION),
                NoRouteToHostException("No route to host") to network.copy(transport = UpdateFailureTransport.CONNECTION),
                SocketException("Connection reset") to network.copy(transport = UpdateFailureTransport.CONNECTION),
                IOException("Canceled") to network.copy(transport = UpdateFailureTransport.CANCELLED),
                IOException("unexpected end of stream") to network,
                IncompleteDownloadException(expectedSize = 10, actualSize = 4) to network,
                LocalStorageException(IOException("No space left on device")) to storage,
                MalformedURLException("no protocol: bundle") to invalidResponse,
                IllegalArgumentException("Expected URL scheme 'http' or 'https' but was 'ftp'") to invalidResponse,
                Exception("Response body is null") to UpdateFailure.download(UpdateFailureReason.UNKNOWN),
            )

        cases.forEach { (cause, failure) ->
            val error = HotUpdaterException.downloadFailed(cause)
            assertEquals("DOWNLOAD_FAILED", error.code)
            assertEquals("$cause", failure, error.failure)
        }
        assertEquals(network, HotUpdaterException.incompleteDownload(expectedSize = 10, actualSize = 4).failure)
    }

    @Test
    fun `a failed host lookup without an active network is offline`() {
        assertEquals(
            network.copy(transport = UpdateFailureTransport.OFFLINE),
            UpdateFailure.ofDownloadError(UnknownHostException("updates.example.com")) { true },
        )
        assertEquals(
            network.copy(transport = UpdateFailureTransport.TIMEOUT),
            UpdateFailure.ofDownloadError(SocketTimeoutException("timeout")) { error("Only a failed host lookup asks") },
        )
    }

    @Test
    fun `verification errors report hash mismatch storage or signature`() {
        val cases =
            listOf(
                SignatureVerificationException.FileHashMismatch() to UpdateFailure.download(UpdateFailureReason.HASH_MISMATCH),
                SignatureVerificationException.FileReadFailed() to storage,
                SignatureVerificationException.PublicKeyNotConfigured() to signature,
                SignatureVerificationException.InvalidPublicKeyFormat() to signature,
                SignatureVerificationException.MissingFileHash() to signature,
                SignatureVerificationException.InvalidSignatureFormat() to signature,
                SignatureVerificationException.SignatureVerificationFailed() to signature,
                SignatureVerificationException.UnsignedNotAllowed() to signature,
                SignatureVerificationException.SecurityFrameworkError(IllegalStateException("provider")) to signature,
            )

        cases.forEach { (cause, failure) ->
            val error = HotUpdaterException.signatureVerificationFailed(cause)
            assertEquals("SIGNATURE_VERIFICATION_FAILED", error.code)
            assertEquals("$cause", failure, error.failure)
        }
    }

    @Test
    fun `parameter validation keeps its codes and reports an invalid response`() {
        val cases =
            listOf(
                Triple(HotUpdaterException.missingBundleId(), "MISSING_BUNDLE_ID", "Missing or empty 'bundleId'") to invalidResponse,
                Triple(HotUpdaterException.invalidManifestParams(), "INVALID_MANIFEST", "Manifest URL, hash, and assets are required") to
                    invalidResponse.copy(resource = UpdateFailureResource.MANIFEST),
                Triple(
                    HotUpdaterException.invalidFileUrl("archiveUrl", "not a url", UpdateFailureResource.ARCHIVE),
                    "INVALID_FILE_URL",
                    "Invalid 'archiveUrl' provided: not a url",
                ) to invalidResponse.copy(resource = UpdateFailureResource.ARCHIVE),
            )

        cases.forEach { (rejection, failure) ->
            val (error, code, message) = rejection
            assertEquals(code, error.code)
            assertEquals(message, error.message)
            assertEquals(failure, error.failure)
        }
        assertEquals(invalidResponse, HotUpdaterException.invalidBundle().failure)
    }

    @Test
    fun `storage failures report install storage`() {
        val cases =
            listOf(
                HotUpdaterException.directoryCreationFailed() to "DIRECTORY_CREATION_FAILED",
                HotUpdaterException.moveOperationFailed() to "MOVE_OPERATION_FAILED",
                HotUpdaterException.insufficientDiskSpace(required = 10, available = 1) to "INSUFFICIENT_DISK_SPACE",
                HotUpdaterException.storageFailed("Failed to persist bundle metadata") to "UNKNOWN_ERROR",
            )

        cases.forEach { (error, code) ->
            assertEquals(code, error.code)
            assertEquals(storage, error.failure)
        }
    }

    @Test
    fun `unexpected errors keep the UNKNOWN_ERROR code and message`() {
        val cause = IllegalStateException("boom")
        val error = HotUpdaterException.unexpected(cause, UpdateFailure.ofUnexpectedError(cause, UpdateFailureStage.INSTALL))

        assertEquals("UNKNOWN_ERROR", error.code)
        assertEquals("boom", error.message)
        assertSame(cause, error.cause)
        assertEquals(UpdateFailure.install(UpdateFailureReason.UNKNOWN), error.failure)
        assertEquals(storage, UpdateFailure.ofUnexpectedError(IOException("read failed"), UpdateFailureStage.DOWNLOAD))
        assertEquals(invalidResponse, UpdateFailure.ofUnexpectedError(MalformedURLException(), UpdateFailureStage.DOWNLOAD))
    }

    @Test
    fun `withResource names the resource only when none is named`() {
        val cause = IOException("reset")
        val error = HotUpdaterException.downloadFailed(cause)

        val named = error.withResource(UpdateFailureResource.FILE)
        assertEquals("DOWNLOAD_FAILED", named.code)
        assertEquals(error.message, named.message)
        assertSame(cause, named.cause)
        assertEquals(error.failure?.copy(resource = UpdateFailureResource.FILE), named.failure)

        assertSame(named, named.withResource(UpdateFailureResource.MANIFEST))
        assertSame(error, error.withResource(null))
        val crashed = HotUpdaterException.bundleInCrashedHistory("crashed-bundle")
        assertSame(crashed, crashed.withResource(UpdateFailureResource.FILE))
    }

    @Test
    fun `a bundle in the crashed history is not an update failure`() {
        assertNull(HotUpdaterException.bundleInCrashedHistory("crashed-bundle").failure)
    }
}
