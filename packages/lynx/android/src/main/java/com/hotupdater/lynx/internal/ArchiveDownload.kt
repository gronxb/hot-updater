package com.hotupdater.lynx.internal

import java.io.File
import java.io.FileOutputStream
import java.io.InterruptedIOException
import java.net.URL
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import okhttp3.OkHttpClient
import okhttp3.Request
import kotlin.coroutines.coroutineContext

/** Adapted from the RN-free OkHttp streaming leaf; each preparation owns its file. */
internal class ArchiveDownload {
    private val client = OkHttpClient.Builder().connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS).callTimeout(120, TimeUnit.SECONDS).build()

    suspend fun download(url: String, target: File, progress: (Long) -> Unit) = withContext(Dispatchers.IO) {
        val parsed = URL(url)
        require(parsed.protocol == "https" || parsed.protocol == "http") { "Unsupported archive URL" }
        require(parsed.userInfo == null) { "Archive URL must not contain credentials" }
        val call = client.newCall(Request.Builder().url(url).build())
        val operationContext = coroutineContext
        try {
            suspendCancellableCoroutine<Unit> { continuation ->
              continuation.invokeOnCancellation { call.cancel() }
              try {
            call.execute().use { response ->
                check(response.isSuccessful) { "Archive HTTP status ${response.code}" }
                val body = checkNotNull(response.body) { "Archive response has no body" }
                val expected = body.contentLength()
                require(expected <= ArchiveLimits.MAX_ARCHIVE_BYTES) { "Archive exceeds download limit" }
                var count = 0L
                body.byteStream().use { input ->
                    FileOutputStream(target).use { output ->
                        val buffer = ByteArray(8192)
                        while (true) {
                            operationContext.ensureActive()
                            if (Thread.currentThread().isInterrupted) throw InterruptedIOException("Archive download interrupted")
                            val size = input.read(buffer)
                            if (size < 0) break
                            count += size
                            require(count <= ArchiveLimits.MAX_ARCHIVE_BYTES) { "Archive exceeds download limit" }
                            output.write(buffer, 0, size)
                            progress(count)
                        }
                        output.fd.sync()
                    }
                }
                check(expected < 0 || count == expected) { "Incomplete archive download" }
                check(count > 0) { "Empty archive download" }
            }
            continuation.resume(Unit)
              } catch (error: Throwable) { continuation.resumeWithException(error) }
            }
        } finally { call.cancel() }
    }
}
