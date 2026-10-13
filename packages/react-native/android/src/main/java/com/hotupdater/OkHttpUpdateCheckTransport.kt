package com.hotupdater

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The check's requests over OkHttp. The request timeout bounds the whole call,
 * body included, as fetchUpdateResponse.ts does; there is no HTTP cache, so a
 * 304 reaches the catalog cache.
 */
internal class OkHttpUpdateCheckTransport(
    private val client: OkHttpClient = OkHttpClient(),
) : UpdateCheckTransport {
    override suspend fun get(request: UpdateCheckRequest): UpdateCheckResponse =
        withContext(Dispatchers.IO) {
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
            val cancellation = coroutineContext[Job]?.invokeOnCompletion { call.cancel() }
            try {
                call.execute().use { response ->
                    val body =
                        try {
                            response.body?.string()
                        } catch (error: IOException) {
                            // A broken error body must not hide an HTTP error already received.
                            if (response.code == 200) throw error
                            null
                        }
                    UpdateCheckResponse(
                        status = response.code,
                        statusText = response.message,
                        headers = response.headers.associate { (name, value) -> name to value },
                        body = body,
                    )
                }
            } finally {
                cancellation?.dispose()
            }
        }
}
