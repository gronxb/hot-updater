package com.hotupdater

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * The check's requests over OkHttp. The request timeout bounds the whole call,
 * body included, as fetchUpdateResponse.ts does; there is no HTTP cache, so a
 * 304 reaches the catalog cache. Cancelling the caller cancels the call at
 * once, so it ends the wait without holding the update lock until the timeout.
 */
internal class OkHttpUpdateCheckTransport(
    private val client: OkHttpClient = OkHttpClient(),
) : UpdateCheckTransport {
    override suspend fun get(request: UpdateCheckRequest): UpdateCheckResponse {
        val call =
            client
                .newBuilder()
                .callTimeout(request.timeoutMillis, TimeUnit.MILLISECONDS)
                .build()
                .newCall(
                    Request
                        .Builder()
                        .url(request.url)
                        .apply { request.headers.forEach { (name, value) -> header(name, value) } }
                        .get()
                        .build(),
                )
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(
                object : Callback {
                    override fun onFailure(
                        call: Call,
                        e: IOException,
                    ) {
                        continuation.resumeWithException(e)
                    }

                    override fun onResponse(
                        call: Call,
                        response: Response,
                    ) {
                        val result = runCatching { response.use(::readResponse) }
                        result.fold(continuation::resume, continuation::resumeWithException)
                    }
                },
            )
        }
    }

    private fun readResponse(response: Response): UpdateCheckResponse {
        val body =
            try {
                response.body?.string()
            } catch (error: IOException) {
                // A broken error body must not hide an HTTP error already received.
                if (response.code == 200) throw error
                null
            }
        return UpdateCheckResponse(
            status = response.code,
            statusText = response.message,
            headers = response.headers.associate { (name, value) -> name to value },
            body = body,
        )
    }
}
