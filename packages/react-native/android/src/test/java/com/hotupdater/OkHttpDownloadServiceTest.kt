package com.hotupdater

import kotlinx.coroutines.runBlocking
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import kotlin.concurrent.thread

class OkHttpDownloadServiceTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `downloadFile succeeds when content length is unknown`() =
        runBlocking {
            val payload = "bundle-content-without-content-length".repeat(512).toByteArray()
            val server = ChunkedResponseServer(payload)

            try {
                val destinationDir = temporaryFolder.newFolder("downloads")
                val destination = File(destinationDir, "bundle.android.bundle")
                var reportedSize: Long? = null

                val result =
                    OkHttpDownloadService().downloadFile(
                        fileUrl = URL("http://127.0.0.1:${server.port}/bundle"),
                        destination = destination,
                        fileSizeCallback = { size -> reportedSize = size },
                        progressCallback = {},
                    )

                assertTrue(result is DownloadResult.Success)
                assertEquals(payload.size.toLong(), destination.length())
                assertArrayEquals(payload, destination.readBytes())
                assertNull(reportedSize)
            } finally {
                server.close()
            }
        }

    @Test
    fun `downloadFile reports a non-2xx response with its status and origin error code`() =
        runBlocking {
            val errorBody =
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
                    "<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message>" +
                    "<Key>bundles/secret/manifest.json</Key></Error>"
            val server = ChunkedResponseServer(errorBody.toByteArray(), statusLine = "404 Not Found")

            try {
                val destination = File(temporaryFolder.newFolder("http-error"), "manifest.json")

                val result =
                    OkHttpDownloadService().downloadFile(
                        fileUrl = URL("http://127.0.0.1:${server.port}/manifest.json"),
                        destination = destination,
                        progressCallback = {},
                    )

                val error = (result as DownloadResult.Error).exception
                assertTrue("Expected HttpStatusException, got $error", error is HttpStatusException)
                assertEquals(404, (error as HttpStatusException).statusCode)
                assertEquals("NoSuchKey", error.originCode)
                assertEquals("HTTP error 404: Not Found", error.message)
                assertFalse(destination.exists())
            } finally {
                server.close()
            }
        }

    @Test
    fun `origin error codes come only from an XML Error Code of safe characters`() {
        val cases =
            mapOf(
                "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>" to "AccessDenied",
                "<?xml version='1.0' encoding='UTF-8'?><Error><Code>SignatureDoesNotMatch</Code></Error>" to "SignatureDoesNotMatch",
                "<Error xmlns=\"urn:storage\">\n  <Message>first</Message>\n  <Code> ExpiredToken </Code>\n</Error>" to "ExpiredToken",
                "<Error><Code>Rate.Limit_Exceeded-2</Code></Error>" to "Rate.Limit_Exceeded-2",
                "<Error><Code>${"A".repeat(64)}</Code></Error>" to "A".repeat(64),
                "<Error><Code>${"A".repeat(65)}</Code></Error>" to null,
                "<Error><Code>Access Denied</Code></Error>" to null,
                "<Error><Code>bundles/secret.json</Code></Error>" to null,
                "<Error><Code></Code></Error>" to null,
                "<Error><Message>No code</Message></Error><Code>Outside</Code>" to null,
                "<Response><Code>NotAnError</Code></Response>" to null,
                "Not Found" to null,
            )

        cases.forEach { (body, expected) -> assertEquals(body, expected, parseOriginErrorCode(body)) }
    }

    @Test
    fun `origin error codes are read from the first 4 KB of the body only`() {
        val limit = MAX_ORIGIN_ERROR_BODY_BYTES.toInt()
        val code = "<Error><Code>AccessDenied</Code>"
        val endsAtLimit = " ".repeat(limit - code.length) + code + "</Error>"
        val closesPastLimit = " ".repeat(limit - code.length + 1) + code + "</Error>"

        assertEquals("AccessDenied", readOriginErrorCode(endsAtLimit.toResponseBody()))
        assertNull(readOriginErrorCode(closesPastLimit.toResponseBody()))
        assertNull(readOriginErrorCode(null))
    }

    @Test
    fun `downloadFile reports a destination it cannot write as a local storage failure`() =
        runBlocking {
            val server = ChunkedResponseServer("bundle-content".toByteArray())

            try {
                val notADirectory = temporaryFolder.newFile("not-a-directory")

                val result =
                    OkHttpDownloadService().downloadFile(
                        fileUrl = URL("http://127.0.0.1:${server.port}/bundle"),
                        destination = File(notADirectory, "index.android.bundle"),
                        progressCallback = {},
                    )

                val error = (result as DownloadResult.Error).exception
                assertTrue("Expected LocalStorageException, got $error", error is LocalStorageException)
            } finally {
                server.close()
            }
        }

    @Test
    fun `downloadFile tries a transient failure again and succeeds on the next attempt`() =
        runBlocking {
            val payload = "bundle-after-retry".toByteArray()
            val server =
                SequencedResponseServer(
                    listOf(
                        "503 Service Unavailable" to "busy".toByteArray(),
                        "200 OK" to payload,
                    ),
                )

            try {
                val destination = File(temporaryFolder.newFolder("retry"), "index.android.bundle")

                val result =
                    OkHttpDownloadService(initialRetryDelayMs = 1).downloadFile(
                        fileUrl = URL("http://127.0.0.1:${server.port}/bundle"),
                        destination = destination,
                        progressCallback = {},
                    )

                assertTrue("Expected success, got $result", result is DownloadResult.Success)
                assertArrayEquals(payload, destination.readBytes())
                assertEquals(2, server.requestCount)
            } finally {
                server.close()
            }
        }

    @Test
    fun `downloadFile tries a 404 once`() =
        runBlocking {
            val server =
                SequencedResponseServer(
                    listOf(
                        "404 Not Found" to "missing".toByteArray(),
                        "200 OK" to "never-sent".toByteArray(),
                    ),
                )

            try {
                val result =
                    OkHttpDownloadService(initialRetryDelayMs = 1).downloadFile(
                        fileUrl = URL("http://127.0.0.1:${server.port}/bundle"),
                        destination = File(temporaryFolder.newFolder("not-found"), "index.android.bundle"),
                        progressCallback = {},
                    )

                val error = (result as DownloadResult.Error).exception
                assertEquals(404, (error as HttpStatusException).statusCode)
                assertEquals(1, server.requestCount)
            } finally {
                server.close()
            }
        }

    @Test
    fun `downloadFile stops after three attempts and returns the last classified failure`() =
        runBlocking {
            val server =
                SequencedResponseServer(
                    listOf(
                        "500 Internal Server Error" to "one".toByteArray(),
                        "429 Too Many Requests" to "two".toByteArray(),
                        "502 Bad Gateway" to "<Error><Code>SlowDown</Code></Error>".toByteArray(),
                        "200 OK" to "never-sent".toByteArray(),
                    ),
                )

            try {
                val result =
                    OkHttpDownloadService(initialRetryDelayMs = 1).downloadFile(
                        fileUrl = URL("http://127.0.0.1:${server.port}/bundle"),
                        destination = File(temporaryFolder.newFolder("exhausted"), "index.android.bundle"),
                        progressCallback = {},
                    )

                val error = (result as DownloadResult.Error).exception as HttpStatusException
                assertEquals(502, error.statusCode)
                assertEquals("SlowDown", error.originCode)
                assertEquals(UpdateFailure.http(502, "SlowDown"), UpdateFailure.ofDownloadError(error))
                assertEquals(OkHttpDownloadService.MAX_ATTEMPTS, server.requestCount)
            } finally {
                server.close()
            }
        }

    @Test
    fun `downloadFileOnce does not retry`() =
        runBlocking {
            val server =
                SequencedResponseServer(
                    listOf(
                        "503 Service Unavailable" to "busy".toByteArray(),
                        "200 OK" to "never-sent".toByteArray(),
                    ),
                )

            try {
                val result =
                    OkHttpDownloadService(initialRetryDelayMs = 1).downloadFileOnce(
                        fileUrl = URL("http://127.0.0.1:${server.port}/bundle.tar.br"),
                        destination = File(temporaryFolder.newFolder("once"), "bundle.tar.br"),
                        progressCallback = {},
                    )

                assertTrue(result is DownloadResult.Error)
                assertEquals(1, server.requestCount)
            } finally {
                server.close()
            }
        }

    @Test
    fun `only transient download failures are retryable`() {
        val retryable =
            listOf(
                HttpStatusException(408, "Request Timeout"),
                HttpStatusException(429, "Too Many Requests"),
                HttpStatusException(500, "Internal Server Error"),
                HttpStatusException(503, "Service Unavailable"),
                java.net.SocketTimeoutException("timeout"),
                java.net.UnknownHostException("updates.example.com"),
                java.net.ConnectException("Connection refused"),
                IncompleteDownloadException(expectedSize = 10, actualSize = 4),
            )
        val final =
            listOf(
                HttpStatusException(400, "Bad Request"),
                HttpStatusException(403, "Forbidden", "ExpiredToken"),
                HttpStatusException(404, "Not Found"),
                LocalStorageException(java.io.IOException("No space left on device")),
                javax.net.ssl.SSLHandshakeException("certificate expired"),
                java.io.IOException("Canceled"),
                java.net.MalformedURLException("no protocol"),
                IllegalArgumentException("unexpected url"),
                Exception("Response body is null"),
            )

        retryable.forEach { assertTrue("$it should be retryable", isRetryableDownloadError(it)) }
        final.forEach { assertFalse("$it should not be retryable", isRetryableDownloadError(it)) }
    }

    /** Answers each connection with the next response, then closes. */
    private class SequencedResponseServer(
        private val responses: List<Pair<String, ByteArray>>,
    ) : AutoCloseable {
        private val serverSocket = ServerSocket(0, responses.size, InetAddress.getByName("127.0.0.1"))

        @Volatile
        var requestCount = 0
            private set

        private val worker =
            thread(start = true, isDaemon = true) {
                try {
                    for ((statusLine, payload) in responses) {
                        serverSocket.accept().use { client ->
                            requestCount++
                            respond(client, statusLine, payload)
                        }
                    }
                } catch (_: java.net.SocketException) {
                    // The test closed the server before every response was asked for.
                }
            }

        val port: Int = serverSocket.localPort

        private fun respond(
            client: Socket,
            statusLine: String,
            payload: ByteArray,
        ) {
            drainRequestHeaders(client)
            client.getOutputStream().use { output ->
                output.write(
                    (
                        "HTTP/1.1 $statusLine\r\n" +
                            "Content-Type: application/octet-stream\r\n" +
                            "Content-Length: ${payload.size}\r\n" +
                            "Connection: close\r\n" +
                            "\r\n"
                    ).toByteArray(),
                )
                output.write(payload)
                output.flush()
            }
        }

        override fun close() {
            serverSocket.close()
            worker.join(1_000)
        }
    }

    private class ChunkedResponseServer(
        private val payload: ByteArray,
        private val statusLine: String = "200 OK",
    ) : AutoCloseable {
        private val serverSocket = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        private val worker =
            thread(start = true, isDaemon = true) {
                serverSocket.use { socket ->
                    socket.accept().use(::respond)
                }
            }

        val port: Int = serverSocket.localPort

        private fun respond(client: Socket) {
            drainRequestHeaders(client)

            client.getOutputStream().use { output ->
                output.write(
                    (
                        "HTTP/1.1 $statusLine\r\n" +
                            "Content-Type: application/octet-stream\r\n" +
                            "Transfer-Encoding: chunked\r\n" +
                            "Connection: close\r\n" +
                            "\r\n"
                    ).toByteArray(),
                )
                output.write(payload.size.toString(16).toByteArray())
                output.write("\r\n".toByteArray())
                output.write(payload)
                output.write("\r\n0\r\n\r\n".toByteArray())
                output.flush()
            }
        }

        override fun close() {
            serverSocket.close()
            worker.join(1_000)
        }
    }
}

/** Reads a request up to the blank line after its headers. */
private fun drainRequestHeaders(client: Socket) {
    val input = client.getInputStream()
    var matched = 0
    val terminator = byteArrayOf('\r'.code.toByte(), '\n'.code.toByte(), '\r'.code.toByte(), '\n'.code.toByte())

    while (matched < terminator.size) {
        val next = input.read()
        if (next == -1) {
            break
        }

        matched =
            if (next.toByte() == terminator[matched]) {
                matched + 1
            } else if (next.toByte() == terminator[0]) {
                1
            } else {
                0
            }
    }
}
