package com.hotupdater

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

class OkHttpUpdateCheckTransportTest {
    @Test
    fun `cancelling the caller ends a request the server never answers`() =
        runBlocking {
            ServerSocket(0).use { server ->
                val accepted = CompletableDeferred<Socket>()
                thread { accepted.complete(server.accept()) }
                val transport = OkHttpUpdateCheckTransport()
                val request =
                    async(Dispatchers.Default) {
                        transport.get(UpdateCheckRequest("http://127.0.0.1:${server.localPort}/", emptyMap(), 60_000))
                    }
                val socket = withTimeout(5_000) { accepted.await() }

                val started = System.nanoTime()
                request.cancel()
                withTimeout(5_000) { request.join() }

                assertTrue(request.isCancelled)
                assertTrue((System.nanoTime() - started) / 1_000_000 < 2_000)
                socket.close()
            }
        }

    @Test
    fun `a response carries its status, headers, and body`() =
        runBlocking {
            ServerSocket(0).use { server ->
                thread {
                    server.accept().use { socket ->
                        socket.getInputStream().bufferedReader().let { reader ->
                            while (reader.readLine()?.isNotEmpty() == true) Unit
                        }
                        socket.getOutputStream().write(
                            "HTTP/1.1 404 Not Found\r\nETag: \"a\"\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnope".toByteArray(),
                        )
                    }
                }

                val response =
                    OkHttpUpdateCheckTransport().get(
                        UpdateCheckRequest("http://127.0.0.1:${server.localPort}/", emptyMap(), 5_000),
                    )

                assertEquals(404, response.status)
                assertEquals("\"a\"", response.header("ETag"))
                assertEquals("nope", response.body)
            }
        }
}
