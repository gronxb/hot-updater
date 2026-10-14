package com.hotupdater

import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread

class HttpArtifactFileResolverTest {
    private lateinit var server: ServerSocket
    private var status = 200
    private var body = ""

    /** Answers each request with [status] and [body]. */
    @Before
    fun startServer() {
        server = ServerSocket(0, 0, InetAddress.getLoopbackAddress())
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val socket =
                    try {
                        server.accept()
                    } catch (_: Exception) {
                        break
                    }
                socket.use {
                    val input = it.getInputStream().bufferedReader()
                    var contentLength = 0
                    while (true) {
                        val line = input.readLine() ?: break
                        if (line.isEmpty()) break
                        if (line.startsWith("Content-Length:", ignoreCase = true)) {
                            contentLength = line.substringAfter(":").trim().toInt()
                        }
                    }
                    repeat(contentLength) { input.read() }
                    val bytes = body.toByteArray()
                    it.getOutputStream().apply {
                        write("HTTP/1.1 $status Status\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                        write(bytes)
                        flush()
                    }
                }
            }
        }
    }

    @After
    fun stopServer() {
        server.close()
    }

    private fun resolver(onResponse: (Int, String?) -> Unit) =
        HttpArtifactFileResolver("http://127.0.0.1:${server.localPort}/files", emptyMap(), onResponse = onResponse)

    @Test
    fun `reports a failing files response before it fails`() {
        status = 500
        body = "boom"
        val responses = mutableListOf<Pair<Int, String?>>()

        assertThrows(HttpStatusException::class.java) {
            runBlocking { resolver { code, text -> responses += code to text }.resolve(listOf("index.android.bundle")) }
        }

        assertEquals(listOf(500 to "boom"), responses)
    }

    @Test
    fun `reads a files response as JSON parse reads it`() {
        val bodies =
            listOf(
                """{"files":{"a.png":{"url":"https://cdn.example.com/a.png"}}} trailing""",
                """{'files':{"a.png":{"url":"https://cdn.example.com/a.png"}}}""",
                """{"files":{"a.png":{"url":"https://cdn.example.com/a.png",}}}""",
                """{"files":{"a.png":{"url":1}}}""",
            )
        for (text in bodies) {
            body = text
            assertThrows(text, InvalidUpdateResponseException::class.java) {
                runBlocking { resolver { _, _ -> }.resolve(listOf("a.png")) }
            }
        }
    }

    @Test
    fun `reports a files response and resolves its URLs`() =
        runBlocking {
            body = """{"files":{"index.android.bundle":{"url":"https://cdn.example.com/b","compression":"br"}}}"""
            val responses = mutableListOf<Pair<Int, String?>>()

            val files = resolver { code, text -> responses += code to text }.resolve(listOf("index.android.bundle"))

            assertEquals(ResolvedArtifactFile("https://cdn.example.com/b", "br"), files["index.android.bundle"])
            assertEquals(listOf(200 to body), responses)
        }
}
