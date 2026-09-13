package com.hotupdater.lynx

import android.graphics.BitmapFactory
import android.graphics.Typeface
import android.net.Uri
import android.util.Log
import com.hotupdater.lynx.internal.HashUtils
import com.hotupdater.lynx.internal.ManagedPaths
import com.lynx.tasm.behavior.LynxContext
import com.lynx.tasm.fontface.FontFace
import com.lynx.tasm.loader.LynxFontFaceLoader
import com.lynx.tasm.resourceprovider.LynxResourceCallback
import com.lynx.tasm.resourceprovider.LynxResourceRequest
import com.lynx.tasm.resourceprovider.LynxResourceResponse
import com.lynx.tasm.resourceprovider.generic.LynxGenericResourceFetcher
import com.lynx.tasm.resourceprovider.media.LynxMediaResourceFetcher
import com.lynx.tasm.resourceprovider.media.OptionalBool
import com.lynx.tasm.resourceprovider.template.LynxTemplateResourceFetcher
import com.lynx.tasm.resourceprovider.template.TemplateProviderResult
import java.io.File
import java.io.FileOutputStream
import java.net.URI
import java.util.UUID

/**
 * Resource requests stay pinned to a verified installation for the context lifetime.
 * The app sandbox protects these files from other UIDs. Code running under the app's
 * own UID remains trusted and can replace any package-private path or snapshot.
 */
class LynxReleaseResources(
    val root: File,
    val releaseId: String,
    verifiedFileHashes: Map<String, String>,
    snapshotDirectory: File,
) {
    val verifiedFileHashes: Map<String, String> =
        java.util.Collections.unmodifiableMap(HashMap(verifiedFileHashes))
    val verifiedPaths: Set<String> get() = verifiedFileHashes.keys
    internal var isLive: () -> Boolean = { true }
    internal var unmanagedGeneric: LynxGenericResourceFetcher? = null
    internal var unmanagedTemplate: LynxTemplateResourceFetcher? = null
    var onFailure: ((String) -> Unit)? = null
    internal var onLoaded: ((String, String, String) -> Unit)? = null
    internal var resourceGate: (((() -> Unit)) -> Unit)? = null
    private val snapshotRoot = snapshotDirectory.canonicalFile
    private val snapshotLock = Any()

    private fun isRemote(url: String): Boolean =
        Uri.parse(url).scheme in setOf("http", "https")

    private fun failed(error: Exception) {
        onFailure?.invoke(error.message ?: "Managed resource failure")
    }

    private fun <T> tracked(operation: () -> T): T {
        var result: Result<T>? = null
        val run = { result = runCatching(operation) }
        resourceGate?.invoke(run) ?: run()
        return checkNotNull(result).getOrThrow()
    }

    val font = object : LynxFontFaceLoader.Loader() {
        override fun onLoadFontFace(
            context: LynxContext,
            type: FontFace.TYPE,
            src: String,
        ): Typeface? {
            if (isRemote(src)) return null
            return try {
                tracked {
                    val snapshot = snapshot(src, "font")
                    Typeface.createFromFile(snapshot.file).also {
                        loaded("fontLoaded", snapshot)
                    }
                }
            } catch (error: Exception) {
                failed(error)
                Log.e("HotUpdaterLynx", "font-failed release=$releaseId src=$src", error)
                null
            }
        }
    }

    fun resolve(url: String, purpose: String = "resource"): File =
        snapshot(url, purpose).file

    private fun resolveSource(url: String): File {
        check(isLive()) { "Native resource context is no longer live" }
        val relative = if (url.startsWith("hot-updater:///")) {
            val uri = URI(url)
            require(uri.authority.isNullOrEmpty() && uri.query == null && uri.fragment == null) {
                "Invalid managed URL"
            }
            requireNotNull(uri.path).removePrefix("/")
        } else {
            val uri = URI(url)
            require(uri.scheme == "file" && uri.authority.isNullOrEmpty()) {
                "Unsupported managed URL: $url"
            }
            val file = File(requireNotNull(uri.path)).absoluteFile
            require(file.path.startsWith(root.canonicalPath + "/")) {
                "Resource outside release: $url"
            }
            file.relativeTo(root.canonicalFile).invariantSeparatorsPath
        }
        require(
            !relative.contains('\\') &&
                !relative.contains('\u0000') &&
                relative.isNotBlank() &&
                relative.split('/').none { it == ".." || it == "." || it.isEmpty() },
        ) { "Invalid resource path: $url" }
        require(verifiedPaths.contains(relative)) {
            "Resource is not in the verified manifest: $url"
        }
        val requested = File(root.canonicalFile, relative).absoluteFile
        val file = requested.canonicalFile
        require(requested == file) { "Symbolic links are not allowed: $url" }
        require(file.path.startsWith(root.canonicalPath + "/") && file.isFile) {
            "Missing managed resource: $url"
        }
        verify(file)
        return file
    }

    private data class Snapshot(
        val file: File,
        val relative: String,
        val hash: String,
    )

    private fun snapshot(url: String, purpose: String): Snapshot {
        val (source, bytes) = readBytes(url)
        val relative = source.relativeTo(root.canonicalFile)
            .invariantSeparatorsPath
        val expected = checkNotNull(verifiedFileHashes[relative])
        val target = synchronized(snapshotLock) {
            check(isLive()) { "Native resource context is no longer live" }
            if (!snapshotRoot.exists()) {
                check(snapshotRoot.mkdirs()) {
                    "Cannot create managed resource snapshot directory"
                }
            }
            require(snapshotRoot.canonicalFile == snapshotRoot) {
                "Invalid managed resource snapshot directory"
            }
            val output = ManagedPaths.resolve(snapshotRoot, relative)
            if (!output.exists()) {
                val parent = checkNotNull(output.parentFile)
                check(parent.mkdirs() || parent.isDirectory) {
                    "Cannot create managed resource snapshot path"
                }
                val temporary = File(
                    parent,
                    ".${output.name}.${UUID.randomUUID()}.tmp",
                )
                try {
                    FileOutputStream(temporary).use {
                        it.write(bytes)
                        it.fd.sync()
                    }
                    require(
                        HashUtils.calculateSHA256(temporary)
                            .equals(expected, ignoreCase = true),
                    ) { "Managed resource snapshot verification failed: $relative" }
                    check(temporary.renameTo(output)) {
                        "Cannot publish managed resource snapshot"
                    }
                    check(output.setReadOnly()) {
                        "Cannot make managed resource snapshot read-only"
                    }
                } finally {
                    temporary.delete()
                }
            }
            require(
                output.isFile && HashUtils.calculateSHA256(output)
                    .equals(expected, ignoreCase = true),
            ) { "Managed resource snapshot changed: $relative" }
            output
        }
        Log.i(
            "HotUpdaterLynx",
            "$purpose release=$releaseId url=$url path=${target.path}",
        )
        return Snapshot(target, relative, expected.lowercase())
    }

    private fun loaded(event: String, file: File) {
        val (relative, hash) = verify(file)
        onLoaded?.invoke(event, relative, hash)
        Log.i("HotUpdaterLynx", "$event release=$releaseId path=${file.path} sha256=$hash")
    }

    private fun loaded(event: String, snapshot: Snapshot) {
        val actual = HashUtils.calculateSHA256(snapshot.file)
        require(actual.equals(snapshot.hash, ignoreCase = true)) {
            "Managed resource snapshot changed: ${snapshot.relative}"
        }
        onLoaded?.invoke(event, snapshot.relative, actual)
        Log.i(
            "HotUpdaterLynx",
            "$event release=$releaseId path=${snapshot.file.path} sha256=$actual",
        )
    }

    private fun readBytes(url: String): Pair<File, ByteArray> {
        val file = resolveSource(url)
        val bytes = file.readBytes()
        val relative = file.relativeTo(root.canonicalFile).invariantSeparatorsPath
        val expected = checkNotNull(verifiedFileHashes[relative]) {
            "Resource lost its verified manifest identity: $url"
        }
        require(HashUtils.calculateSHA256(bytes).equals(expected, ignoreCase = true)) {
            "Managed resource changed after verification: $url"
        }
        return file to bytes
    }

    private fun verify(file: File): Pair<String, String> {
        val relative = file.relativeTo(root.canonicalFile).invariantSeparatorsPath
        val expected = checkNotNull(verifiedFileHashes[relative]) {
            "Resource lost its verified manifest identity: $relative"
        }
        val actual = HashUtils.calculateSHA256(file)
        require(actual.equals(expected, ignoreCase = true)) {
            "Managed resource changed after verification: $relative"
        }
        return relative to actual
    }

    internal fun loadBytes(url: String, consume: (ByteArray) -> Unit) = tracked {
        val (file, bytes) = readBytes(url)
        consume(bytes)
        loaded("resourceLoaded", file)
    }

    internal fun loadPath(url: String, consume: (String) -> Unit) = tracked {
        val snapshot = snapshot(url, "resource")
        consume(snapshot.file.path)
        loaded("resourceLoaded", snapshot)
    }

    val media = object : LynxMediaResourceFetcher() {
        override fun isLocalResource(url: String): OptionalBool =
            if (url.startsWith("hot-updater:///")) OptionalBool.TRUE else OptionalBool.UNDEFINED

        override fun shouldRedirectUrl(request: LynxResourceRequest): String = try {
            if (isRemote(request.url)) {
                request.url
            } else {
                tracked {
                    val snapshot = snapshot(request.url, "image")
                    val bitmap = requireNotNull(
                        BitmapFactory.decodeFile(snapshot.file.path),
                    ) {
                        "Managed image could not be decoded: ${request.url}"
                    }
                    bitmap.recycle()
                    loaded("imageLoaded", snapshot)
                    Uri.fromFile(snapshot.file).toString()
                }
            }
        } catch (error: Exception) {
            failed(error)
            Log.e(
                "HotUpdaterLynx",
                "managed-resource-failure release=$releaseId url=${request.url}",
                error,
            )
            Uri.fromFile(File(root, "hot-updater-lynx.json/.missing-resource")).toString()
        }
    }

    val template = object : LynxTemplateResourceFetcher() {
        override fun fetchTemplate(
            request: LynxResourceRequest,
            callback: LynxResourceCallback<TemplateProviderResult>,
        ) {
            if (isRemote(request.url)) {
                val delegate = unmanagedTemplate
                if (delegate != null) delegate.fetchTemplate(request, callback)
                else callback.onResponse(
                    LynxResourceResponse.onFailed(
                        IllegalArgumentException("Unmanaged template requires a host resource fetcher"),
                    ) as LynxResourceResponse<TemplateProviderResult>,
                )
                return
            }
            try {
                tracked {
                    val (file, bytes) = readBytes(request.url)
                    callback.onResponse(
                        LynxResourceResponse.onSuccess(
                            TemplateProviderResult.fromBinary(bytes),
                        ),
                    )
                    loaded("resourceLoaded", file)
                }
            } catch (error: Exception) {
                failed(error)
                callback.onResponse(
                    LynxResourceResponse.onFailed(error) as LynxResourceResponse<TemplateProviderResult>,
                )
            }
        }

        override fun fetchSSRData(
            request: LynxResourceRequest,
            callback: LynxResourceCallback<ByteArray>,
        ) {
            callback.onResponse(
                LynxResourceResponse.onFailed(
                    IllegalArgumentException("SSR is not in the fixture contract"),
                ) as LynxResourceResponse<ByteArray>,
            )
        }
    }

    val generic = object : LynxGenericResourceFetcher() {
        override fun fetchResource(
            request: LynxResourceRequest,
            callback: LynxResourceCallback<ByteArray>,
        ) {
            if (isRemote(request.url)) {
                val delegate = unmanagedGeneric
                if (delegate != null) delegate.fetchResource(request, callback)
                else callback.onResponse(
                    LynxResourceResponse.onFailed(
                        IllegalArgumentException("Unmanaged resource requires a host resource fetcher"),
                    ) as LynxResourceResponse<ByteArray>,
                )
                return
            }
            try {
                tracked {
                    val (file, bytes) = readBytes(request.url)
                    callback.onResponse(
                        LynxResourceResponse.onSuccess(bytes),
                    )
                    loaded("resourceLoaded", file)
                }
            } catch (error: Exception) {
                failed(error)
                callback.onResponse(
                    LynxResourceResponse.onFailed(error) as LynxResourceResponse<ByteArray>,
                )
            }
        }

        override fun fetchResourcePath(
            request: LynxResourceRequest,
            callback: LynxResourceCallback<String>,
        ) {
            if (isRemote(request.url)) {
                val delegate = unmanagedGeneric
                if (delegate != null) delegate.fetchResourcePath(request, callback)
                else callback.onResponse(
                    LynxResourceResponse.onFailed(
                        IllegalArgumentException("Unmanaged resource requires a host resource fetcher"),
                    ) as LynxResourceResponse<String>,
                )
                return
            }
            try {
                loadPath(request.url) { path ->
                    callback.onResponse(LynxResourceResponse.onSuccess(path))
                }
            } catch (error: Exception) {
                failed(error)
                callback.onResponse(
                    LynxResourceResponse.onFailed(error) as LynxResourceResponse<String>,
                )
            }
        }
    }

    internal fun close() {
        synchronized(snapshotLock) {
            snapshotRoot.deleteRecursively()
        }
    }
}
