package com.hotupdater

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** A download URL the server signed for one manifest file. */
data class ResolvedArtifactFile(
    val url: String,
    val compression: String?,
)

/**
 * Artifact protocol v2: the server signs only the files an install downloads
 * one by one, after reusing local files and choosing the archive.
 */
interface ArtifactFileResolver {
    /** Download URLs for [paths], at most [ARTIFACT_FILES_REQUEST_LIMIT]. */
    suspend fun resolve(paths: List<String>): Map<String, ResolvedArtifactFile>

    companion object {
        /** `ARTIFACT_FILES_REQUEST_LIMIT` in @hot-updater/protocol. */
        const val ARTIFACT_FILES_REQUEST_LIMIT = 100
    }
}

/**
 * POSTs `{ paths }` to the files URL the SDK composed, with the update check's
 * headers and request timeout. [onResponse] receives each response's status
 * and body, or a null body when it could not be read.
 */
class HttpArtifactFileResolver(
    private val filesUrl: String,
    private val headers: Map<String, String>,
    private val timeoutMs: Long = DEFAULT_TIMEOUT_MS,
    private val onResponse: ((status: Int, body: String?) -> Unit)? = null,
) : ArtifactFileResolver {
    override suspend fun resolve(paths: List<String>): Map<String, ResolvedArtifactFile> =
        withContext(Dispatchers.IO) {
            val body = JSONObject().put("paths", JSONArray(paths)).toString()
            val request =
                Request
                    .Builder()
                    .url(filesUrl)
                    .header("Accept", "application/json")
                    .apply { headers.forEach { (name, value) -> header(name, value) } }
                    .post(body.toRequestBody("application/json".toMediaType()))
                    .build()
            client
                .newBuilder()
                .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .build()
                .newCall(request)
                .execute()
                .use { response ->
                    val body =
                        try {
                            response.body?.string()
                        } catch (error: java.io.IOException) {
                            onResponse?.invoke(response.code, null)
                            throw error
                        }
                    onResponse?.invoke(response.code, body)
                    if (!response.isSuccessful) {
                        throw HttpStatusException(response.code, response.message)
                    }
                    // As JSON.parse reads it, which org.json's parser does not.
                    val files =
                        (StrictJson.parse(body ?: "") as? JSONObject)?.opt("files") as? JSONObject
                            ?: throw InvalidUpdateResponseException("Artifact files response has no files")
                    paths.associateWith { path ->
                        val file =
                            files.opt(path) as? JSONObject
                                ?: throw InvalidUpdateResponseException("Artifact files response omits $path")
                        ResolvedArtifactFile(
                            url =
                                file.opt("url") as? String
                                    ?: throw InvalidUpdateResponseException("Artifact files response has no URL for $path"),
                            compression = file.opt("compression") as? String,
                        )
                    }
                }
        }

    companion object {
        /** The SDK's request timeout when the app sets none. */
        const val DEFAULT_TIMEOUT_MS = 5_000L

        private val client = OkHttpClient()
    }
}
