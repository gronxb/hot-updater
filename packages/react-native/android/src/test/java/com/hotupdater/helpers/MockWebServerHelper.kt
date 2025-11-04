package com.hotupdater.helpers

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.io.ByteArrayOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * Helper class for setting up and managing MockWebServer instances in tests.
 *
 * This class provides convenient methods to:
 * - Start and stop a mock HTTP server
 * - Enqueue various types of responses (success, error, slow)
 * - Create mock ZIP bundle responses for testing update downloads
 * - Simulate network errors and edge cases
 *
 * @example
 * ```kotlin
 * @Test
 * fun testDownload() {
 *     val mockServer = MockWebServerHelper()
 *     val url = mockServer.start()
 *
 *     // Enqueue a successful ZIP response
 *     val zipData = mockServer.createMockZipBundle(mapOf("index.js" to "console.log('test')"))
 *     mockServer.enqueueSuccess(zipData)
 *
 *     // Test your download logic
 *     // ...
 *
 *     mockServer.shutdown()
 * }
 * ```
 */
class MockWebServerHelper {
    private val server = MockWebServer()

    /**
     * Starts the mock web server and returns its base URL.
     *
     * @return The base URL of the started server (e.g., "http://localhost:12345/")
     */
    fun start(): String {
        server.start()
        return server.url("/").toString()
    }

    /**
     * Enqueues a successful response with the provided body.
     *
     * @param body The response body as a byte array
     * @param contentType The Content-Type header value (default: "application/zip")
     * @param headers Additional headers to include in the response
     */
    fun enqueueSuccess(
        body: ByteArray,
        contentType: String = "application/zip",
        headers: Map<String, String> = emptyMap(),
    ) {
        val response =
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", contentType)
                .setBody(okio.Buffer().write(body))

        headers.forEach { (key, value) ->
            response.setHeader(key, value)
        }

        server.enqueue(response)
    }

    /**
     * Enqueues an HTTP error response with the specified status code.
     *
     * @param code The HTTP status code (e.g., 404, 500)
     * @param body Optional response body (default: empty string)
     */
    fun enqueueError(
        code: Int,
        body: String = "",
    ) {
        val response =
            MockResponse()
                .setResponseCode(code)
                .setBody(body)

        server.enqueue(response)
    }

    /**
     * Enqueues a successful response with artificial network delay.
     *
     * Useful for testing timeout handling or progress indicators.
     *
     * @param body The response body as a byte array
     * @param delayMs The delay in milliseconds before the response is sent
     * @param contentType The Content-Type header value (default: "application/zip")
     */
    fun enqueueSlowResponse(
        body: ByteArray,
        delayMs: Long,
        contentType: String = "application/zip",
    ) {
        val response =
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", contentType)
                .setBody(okio.Buffer().write(body))
                .setBodyDelay(delayMs, java.util.concurrent.TimeUnit.MILLISECONDS)

        server.enqueue(response)
    }

    /**
     * Enqueues a response that simulates a socket timeout.
     *
     * The connection will be kept open without sending any data,
     * causing the client to eventually timeout.
     */
    fun enqueueTimeout() {
        val response =
            MockResponse()
                .setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.NO_RESPONSE)

        server.enqueue(response)
    }

    /**
     * Enqueues a response that simulates a network disconnect.
     *
     * The connection will be closed abruptly during the response.
     */
    fun enqueueDisconnect() {
        val response =
            MockResponse()
                .setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY)

        server.enqueue(response)
    }

    /**
     * Creates a mock ZIP bundle containing the specified files.
     *
     * This is useful for testing bundle download and extraction logic.
     *
     * @param files A map of file paths to their contents (e.g., "index.js" to "console.log('hello')")
     * @return A byte array containing the ZIP file data
     *
     * @example
     * ```kotlin
     * val zipData = mockServer.createMockZipBundle(mapOf(
     *     "index.android.bundle" to "var x = 1;",
     *     "assets/logo.png" to "fake png data"
     * ))
     * ```
     */
    fun createMockZipBundle(files: Map<String, String>): ByteArray {
        val byteArrayOutputStream = ByteArrayOutputStream()
        ZipOutputStream(byteArrayOutputStream).use { zipOut ->
            files.forEach { (path, content) ->
                val entry = ZipEntry(path)
                zipOut.putNextEntry(entry)
                zipOut.write(content.toByteArray(Charsets.UTF_8))
                zipOut.closeEntry()
            }
        }
        return byteArrayOutputStream.toByteArray()
    }

    /**
     * Creates a mock ZIP bundle containing binary file data.
     *
     * @param files A map of file paths to their binary contents
     * @return A byte array containing the ZIP file data
     */
    fun createMockZipBundleWithBinaryFiles(files: Map<String, ByteArray>): ByteArray {
        val byteArrayOutputStream = ByteArrayOutputStream()
        ZipOutputStream(byteArrayOutputStream).use { zipOut ->
            files.forEach { (path, content) ->
                val entry = ZipEntry(path)
                zipOut.putNextEntry(entry)
                zipOut.write(content)
                zipOut.closeEntry()
            }
        }
        return byteArrayOutputStream.toByteArray()
    }

    /**
     * Returns the number of requests received by the server so far.
     *
     * @return The request count
     */
    fun getRequestCount(): Int = server.requestCount

    /**
     * Retrieves a recorded request by index.
     *
     * @param index The index of the request (0-based)
     * @return The recorded request, or null if index is out of bounds
     */
    fun takeRequest(timeoutMs: Long = 0): okhttp3.mockwebserver.RecordedRequest? =
        try {
            if (timeoutMs > 0) {
                server.takeRequest(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
            } else {
                server.takeRequest()
            }
        } catch (e: Exception) {
            null
        }

    /**
     * Shuts down the mock web server.
     *
     * Should be called after each test to free up the port.
     */
    fun shutdown() {
        try {
            server.shutdown()
        } catch (e: Exception) {
            // Ignore shutdown errors
        }
    }

    /**
     * Gets the base URL of the running server.
     *
     * @return The base URL, or null if the server hasn't been started
     */
    fun getUrl(): String? =
        try {
            server.url("/").toString()
        } catch (e: Exception) {
            null
        }
}
