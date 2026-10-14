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

/** POSTs `{ paths }` to the files URL the SDK composed, with the update check's headers. */
class HttpArtifactFileResolver(
    private val filesUrl: String,
    private val headers: Map<String, String>,
) : ArtifactFileResolver {
    override suspend fun resolve(paths: List<String>): Map<String, ResolvedArtifactFile> =
        withContext(Dispatchers.IO) {
            val body = JSONObject().put("paths", JSONArray(paths)).toString()
            val request =
                Request
                    .Builder()
                    .url(filesUrl)
                    .apply { headers.forEach { (name, value) -> header(name, value) } }
                    .header("Accept", "application/json")
                    .post(body.toRequestBody("application/json".toMediaType()))
                    .build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw HttpStatusException(response.code, response.message)
                }
                val files =
                    JSONObject(response.body?.string() ?: "").optJSONObject("files")
                        ?: throw IllegalStateException("Artifact files response has no files")
                paths.associateWith { path ->
                    val file =
                        files.optJSONObject(path)
                            ?: throw IllegalStateException("Artifact files response omits $path")
                    ResolvedArtifactFile(
                        url = file.getString("url"),
                        compression =
                            if (file.has("compression") && !file.isNull("compression")) file.getString("compression") else null,
                    )
                }
            }
        }

    private companion object {
        private const val TIMEOUT_SECONDS = 30L

        private val client =
            OkHttpClient
                .Builder()
                .connectTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .readTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .writeTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .build()
    }
}
