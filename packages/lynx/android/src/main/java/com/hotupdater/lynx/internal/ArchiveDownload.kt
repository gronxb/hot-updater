package com.hotupdater.lynx.internal

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.URL
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/** Streams an HTTP(S) response into an attempt-owned file. */
internal class ArchiveDownload {
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(120, TimeUnit.SECONDS)
        .build()

    suspend fun download(
        url: String,
        target: File,
        progress: (Long) -> Unit,
        maxBytes: Long = ArchiveLimits.MAX_ARCHIVE_BYTES,
        allowEmpty: Boolean = false,
    ) = suspendCancellableCoroutine<Unit> { continuation ->
        require(maxBytes >= 0) { "Invalid download limit" }
        val parsed = URL(url)
        require(
            (parsed.protocol == "https" || parsed.protocol == "http") &&
                parsed.host.isNotBlank() &&
                (parsed.port == -1 || parsed.port in 1..65535),
        ) { "Unsupported artifact URL" }
        require(parsed.userInfo == null) { "Artifact URL must not contain credentials" }
        target.parentFile?.let(DurableFiles::directory)
        val call = client.newCall(Request.Builder().url(parsed).get().build())
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (continuation.isActive) continuation.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                try {
                    response.use {
                        check(response.isSuccessful) {
                            "Artifact HTTP status ${response.code}"
                        }
                        val body = checkNotNull(response.body) {
                            "Artifact response has no body"
                        }
                        val expected = body.contentLength()
                        require(expected < 0 || expected <= maxBytes) {
                            "Artifact exceeds download limit"
                        }
                        var count = 0L
                        body.byteStream().use { input ->
                            FileOutputStream(target).use { output ->
                                val buffer = ByteArray(64 * 1024)
                                while (true) {
                                    if (!continuation.isActive) {
                                        throw IOException("Artifact download cancelled")
                                    }
                                    val size = input.read(buffer)
                                    if (size < 0) break
                                    count += size
                                    require(count <= maxBytes) {
                                        "Artifact exceeds download limit"
                                    }
                                    output.write(buffer, 0, size)
                                    progress(count)
                                }
                                output.fd.sync()
                            }
                        }
                        check(expected < 0 || count == expected) {
                            "Incomplete artifact download"
                        }
                        check(allowEmpty || count > 0) { "Empty artifact download" }
                    }
                    if (continuation.isActive) continuation.resume(Unit)
                } catch (error: Throwable) {
                    if (continuation.isActive) continuation.resumeWithException(error)
                }
            }
        })
    }
}
