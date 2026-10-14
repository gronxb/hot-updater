package com.hotupdater

import org.json.JSONArray
import org.json.JSONObject
import java.net.MalformedURLException
import java.net.URL
import java.util.Locale

/** An artifact response as protocol 1 describes it, its assets parsed like the TurboModule's `updateBundle`. */
internal class ResolvedArtifact(
    val manifestUrl: String,
    val manifestFileHash: String,
    val archiveUrl: String?,
    val assets: Map<String, ChangedAssetDescriptor>,
)

/**
 * The catalog and artifact requests of httpClient.ts, with the catalog's ETag
 * cache of releaseCatalogCache.ts kept in the native release catalog cache.
 */
internal class ReleaseCatalogClient(
    private val state: UpdateCheckState,
    private val transport: UpdateCheckTransport,
) {
    companion object {
        private const val CACHE_FORMAT_VERSION = "1"
        private const val MAX_ETAG_BYTES = 1024
        private const val MAX_CACHE_ENTRY_BYTES = ReleaseCatalogs.MAX_RELEASE_CATALOG_WIRE_BYTES + MAX_ETAG_BYTES + 3
        private const val ARTIFACT_PROTOCOL_VERSION = 1.0
        private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
        private val HTTP_URL = Regex("^https?://.*", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
    }

    private class CachedCatalog(
        val catalog: ReleaseCatalog,
        val etag: String,
    )

    /**
     * Fetches a scope's catalog, or null when the server answers that the scope
     * has none (a 404 with `x-hot-updater-catalog: none`).
     */
    suspend fun fetchReleaseCatalog(
        baseURL: String,
        url: String,
        expectedScope: ReleaseCatalogScope,
        requestHeaders: Map<String, String>,
        requestTimeoutMillis: Long,
    ): ReleaseCatalog? {
        val partition = cachePartition(baseURL, url, requestHeaders)
        val cached = readValidatedCache(partition, expectedScope)
        val response = fetchCatalogResponse(url, requestHeaders, requestTimeoutMillis, cached?.etag)

        if (response.status == 304) {
            if (cached != null) return cached.catalog

            val repairResponse = fetchCatalogResponse(url, requestHeaders, requestTimeoutMillis, null)
            return consumeSuccessfulResponse(repairResponse, expectedScope, partition)
        }

        return consumeSuccessfulResponse(response, expectedScope, partition)
    }

    suspend fun resolveArtifact(
        baseURL: String,
        currentBundleId: String,
        targetBundleId: String,
        requestHeaders: Map<String, String>,
        requestTimeoutMillis: Long,
    ): ResolvedArtifact {
        val headers = LinkedHashMap(effectiveHeaders(requestHeaders))
        if (!headers.containsKey("accept")) headers["accept"] = "application/json"
        val response =
            transport.get(
                UpdateCheckRequest(
                    url = "$baseURL/artifacts/v1/${encodeURIComponent(targetBundleId)}/from/${encodeURIComponent(currentBundleId)}",
                    headers = headers,
                    timeoutMillis = requestTimeoutMillis,
                    resource = "artifact",
                ),
            )
        if (response.status != 200) {
            throw UpdateHttpException(response.status, response.statusText)
        }
        return parseArtifact(response.body ?: throw InvalidUpdateResponseException("Received an empty artifact response"))
    }

    /** Any stable string per server, route, and headers; it need not match JavaScript's partition. */
    private fun cachePartition(
        baseURL: String,
        url: String,
        requestHeaders: Map<String, String>,
    ): String {
        val headers = JSONArray()
        effectiveHeaders(requestHeaders)
            .entries
            .sortedBy { it.key }
            .forEach { (name, value) -> headers.put(JSONArray().put(name).put(value)) }
        return "native:" +
            JSONObject()
                .put("baseURL", baseURL)
                .put("url", url)
                .put("headers", headers)
                .toString()
    }

    private suspend fun fetchCatalogResponse(
        url: String,
        requestHeaders: Map<String, String>,
        requestTimeoutMillis: Long,
        etag: String?,
    ): UpdateCheckResponse {
        val headers = LinkedHashMap<String, String>()
        effectiveHeaders(requestHeaders).forEach { (name, value) ->
            if (name != "accept" && name != "if-none-match") headers[name] = value
        }
        headers["accept"] = "application/json"
        if (etag != null) headers["if-none-match"] = etag
        return transport.get(UpdateCheckRequest(url, headers, requestTimeoutMillis))
    }

    private fun readValidatedCache(
        partition: String,
        expectedScope: ReleaseCatalogScope,
    ): CachedCatalog? {
        val value = state.getReleaseCatalogCache(partition) ?: return null
        val cached = parseCache(value, expectedScope)
        if (cached == null) {
            state.removeReleaseCatalogCache(partition)
        }
        return cached
    }

    private fun parseCache(
        value: String,
        expectedScope: ReleaseCatalogScope,
    ): CachedCatalog? {
        val versionEnd = value.indexOf('\n')
        val etagEnd = value.indexOf('\n', versionEnd + 1)
        if (versionEnd == -1 || etagEnd == -1 || value.substring(0, versionEnd) != CACHE_FORMAT_VERSION) {
            return null
        }
        val etag = value.substring(versionEnd + 1, etagEnd)
        if (!isValidETag(etag)) return null
        val catalog = ReleaseCatalogs.parse(value.substring(etagEnd + 1), expectedScope) ?: return null
        return CachedCatalog(catalog, etag)
    }

    private fun consumeSuccessfulResponse(
        response: UpdateCheckResponse,
        expectedScope: ReleaseCatalogScope,
        partition: String,
    ): ReleaseCatalog? {
        // The server marks the 404 of a scope that has no catalog yet: no update,
        // not a failure. Any other 404 is a wrong baseURL or route.
        if (
            response.status == 404 &&
            response.header("x-hot-updater-catalog")?.trimJsWhitespace()?.lowercase(Locale.ROOT) == "none"
        ) {
            return null
        }
        if (response.status != 200) {
            throw UpdateHttpException(response.status, response.statusText)
        }

        val body = response.body
        val catalog = body?.let { ReleaseCatalogs.parse(it, expectedScope) }
        if (body == null || catalog == null) {
            state.removeReleaseCatalogCache(partition)
            throw InvalidUpdateResponseException("Received an invalid Release catalog")
        }

        val etag = response.header("etag")
        if (isValidETag(etag)) {
            val serialized = "$CACHE_FORMAT_VERSION\n$etag\n$body"
            if (ReleaseCatalogs.utf8ByteLength(serialized) > MAX_CACHE_ENTRY_BYTES) {
                state.removeReleaseCatalogCache(partition)
                return catalog
            }
            state.setReleaseCatalogCache(partition, serialized)
        } else {
            state.removeReleaseCatalogCache(partition)
        }
        return catalog
    }

    private fun isValidETag(value: String?): Boolean =
        value != null &&
            value.isNotEmpty() &&
            !value.contains('\r') &&
            !value.contains('\n') &&
            ReleaseCatalogs.utf8ByteLength(value) <= MAX_ETAG_BYTES

    /** `requireArtifactProtocolV1` and `requireArtifactUrls` of httpClient.ts, then the TurboModule's asset parsing. */
    private fun parseArtifact(body: String): ResolvedArtifact {
        // As JSON.parse reads it, which org.json's parser does not.
        val info =
            StrictJson.parse(body) as? JSONObject
                ?: throw InvalidUpdateResponseException("Received an invalid artifact response")
        val protocolVersion = info.opt("artifactProtocolVersion")
        val assets = info.opt("assets") as? JSONObject
        val manifestUrl = info.opt("manifestUrl") as? String
        val manifestFileHash = info.opt("manifestFileHash") as? String
        val archiveUrl = info.opt("archiveUrl")
        if (
            protocolVersion !is Number ||
            protocolVersion.toDouble() != ARTIFACT_PROTOCOL_VERSION ||
            assets == null ||
            manifestUrl.isNullOrEmpty() ||
            manifestFileHash.isNullOrEmpty() ||
            (archiveUrl != null && archiveUrl !is String)
        ) {
            throw InvalidUpdateResponseException("Server does not support artifact protocol 1.")
        }
        val assetObjects =
            assets
                .keys()
                .asSequence()
                .map { it to assets.opt(it) }
                .toList()
        for ((_, asset) in assetObjects) {
            val file = (asset as? JSONObject)?.opt("file") as? JSONObject
            val fileUrl = file?.opt("url") as? String
            val fileHash = (asset as? JSONObject)?.opt("fileHash") as? String
            if (fileUrl.isNullOrEmpty() || fileHash.isNullOrEmpty()) {
                throw InvalidUpdateResponseException("Artifact protocol 1 requires an original file for every asset.")
            }
        }

        requireArtifactUrl(manifestUrl)
        val archive = (archiveUrl as? String)?.takeIf { it.isNotEmpty() }
        archive?.let(::requireArtifactUrl)
        val parsedAssets = linkedMapOf<String, ChangedAssetDescriptor>()
        for ((path, value) in assetObjects) {
            val asset = value as JSONObject
            val file = asset.getJSONObject("file")
            val fileUrl = requireArtifactUrl(file.getString("url"))
            val patch =
                when (val patchValue = asset.opt("patch")) {
                    null, JSONObject.NULL, false -> null
                    is JSONObject -> parsePatch(patchValue)
                    else -> throw InvalidUpdateResponseException("Artifact URLs must be absolute HTTP(S) URLs.")
                }
            parsedAssets[path] =
                ChangedAssetDescriptor(
                    fileUrl = fileUrl,
                    fileHash = asset.getString("fileHash"),
                    fileCompression = file.opt("compression") as? String,
                    patch = patch,
                )
        }
        return ResolvedArtifact(
            manifestUrl = manifestUrl,
            manifestFileHash = manifestFileHash,
            archiveUrl = archive,
            assets = parsedAssets,
        )
    }

    private fun parsePatch(patch: JSONObject): BsdiffPatchDescriptor? {
        // A patch's URL is checked even when the rest is incomplete.
        requireArtifactUrl(patch.opt("patchUrl") as? String ?: "")
        val algorithm = patch.opt("algorithm") as? String
        val baseBundleId = patch.opt("baseBundleId") as? String
        val baseFileHash = patch.opt("baseFileHash") as? String
        val patchFileHash = patch.opt("patchFileHash") as? String
        val patchUrl = patch.opt("patchUrl") as? String
        if (algorithm == null || baseBundleId == null || baseFileHash == null || patchFileHash == null || patchUrl == null) {
            return null
        }
        return BsdiffPatchDescriptor(
            algorithm = algorithm,
            baseBundleId = baseBundleId,
            baseFileHash = baseFileHash,
            patchFileHash = patchFileHash,
            patchUrl = patchUrl,
            byteSize = readSafeInteger(patch.opt("byteSize")),
        )
    }

    private fun readSafeInteger(value: Any?): Long? {
        if (value !is Number) return null
        val number = value.toDouble()
        if (!number.isFinite() || number % 1.0 != 0.0) return null
        return number.toLong().takeIf { it in 0..MAX_SAFE_INTEGER }
    }

    /** A URL the device downloads from: the server returns each one absolute. */
    private fun requireArtifactUrl(value: String): String {
        if (!HTTP_URL.matches(value)) {
            throw InvalidUpdateResponseException("Artifact URLs must be absolute HTTP(S) URLs.")
        }
        val url =
            try {
                URL(value)
            } catch (error: MalformedURLException) {
                throw InvalidUpdateResponseException("Invalid artifact URL: $value", error)
            }
        // java.net.URL parses a hostless "https://"; a download needs a host.
        if (url.host.isNullOrEmpty()) {
            throw InvalidUpdateResponseException("Invalid artifact URL: $value")
        }
        return value
    }
}

/**
 * The headers a request sends: names are case-insensitive and lowercased, and
 * the last value of a name wins, as OkHttp's `header` replaces it. Request
 * identities use these, so two maps that send the same headers share one.
 */
internal fun effectiveHeaders(headers: Map<String, String>): Map<String, String> {
    val effective = LinkedHashMap<String, String>()
    headers.forEach { (name, value) -> effective[name.lowercase(Locale.ROOT)] = value }
    return effective
}
