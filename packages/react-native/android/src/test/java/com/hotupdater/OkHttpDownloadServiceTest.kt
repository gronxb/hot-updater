package com.hotupdater

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
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

    private class ChunkedResponseServer(
        private val payload: ByteArray,
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
                        "HTTP/1.1 200 OK\r\n" +
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

        override fun close() {
            serverSocket.close()
            worker.join(1_000)
        }
    }
}
