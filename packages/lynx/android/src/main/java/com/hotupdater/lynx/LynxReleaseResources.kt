package com.hotupdater.lynx

import android.graphics.Typeface
import android.util.Log
import com.hotupdater.lynx.internal.HashUtils
import com.hotupdater.lynx.internal.ManagedPaths
import com.lynx.tasm.LynxViewBuilder
import com.lynx.tasm.behavior.LynxContext
import com.lynx.tasm.fontface.FontFace
import com.lynx.tasm.loader.LynxFontFaceLoader
import com.lynx.tasm.provider.LynxProviderRegistry
import com.lynx.tasm.provider.LynxResourceProvider
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
import java.util.concurrent.atomic.AtomicBoolean

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
    internal companion object {
        private val cleanupLock = Any()
        private val cleanedSnapshotParents = mutableSetOf<String>()

        /** A fresh process has no decoder that can still hold an old snapshot. */
        fun cleanOrphanedSnapshots(snapshotParent: File) {
            val directory = snapshotParent.canonicalFile
            synchronized(cleanupLock) {
                if (cleanedSnapshotParents.add(directory.path)) {
                    directory.deleteRecursively()
                }
            }
        }
    }

    private class StaleResourceContext : IllegalStateException(
        "Native resource context is no longer live",
    )

    val verifiedFileHashes: Map<String, String> =
        java.util.Collections.unmodifiableMap(HashMap(verifiedFileHashes))
    val verifiedPaths: Set<String> get() = verifiedFileHashes.keys
    internal var isLive: () -> Boolean = { true }
    internal var unmanagedGeneric: LynxGenericResourceFetcher? = null
    internal var unmanagedTemplate: LynxTemplateResourceFetcher? = null
    private var unmanagedFontPath: LynxResourceProvider<Any, String>? = null
    private var unmanagedExternalScript: LynxResourceProvider<Any, ByteArray>? = null
    var onFailure: ((String) -> Unit)? = null
    internal var onLoaded: ((String, String, String) -> Unit)? = null
    internal var resourceGate: (((() -> Unit)) -> Unit)? = null
    private val snapshotRoot = snapshotDirectory.canonicalFile
    private val snapshotLock = Any()
    private val leaseLock = Any()
    private var asynchronousLeases = 0
    private var closeRequested = false
    private var imageServiceRegistration: ManagedLynxImageServices.Registration? = null

    internal fun isManaged(url: String): Boolean =
        url.startsWith("hot-updater:///")

    internal fun owns(url: String): Boolean {
        if (isManaged(url) || snapshotForUrl(url) != null) return true
        val uri = runCatching { URI(url) }.getOrNull() ?: return false
        if (uri.scheme != "file" || !uri.authority.isNullOrEmpty()) return false
        val requested = runCatching { File(requireNotNull(uri.path)).absoluteFile }
            .getOrNull() ?: return false
        val file = runCatching { requested.canonicalFile }.getOrNull() ?: return false
        if (requested != file || !file.path.startsWith(root.canonicalPath + "/")) {
            return false
        }
        return file.relativeTo(root.canonicalFile).invariantSeparatorsPath in verifiedPaths
    }

    private fun isRemote(url: String): Boolean =
        runCatching { URI(url).scheme in setOf("http", "https") }
            .getOrDefault(false)

    internal fun failed(error: Exception) {
        onFailure?.invoke(error.message ?: "Managed resource failure")
    }

    private fun <T> tracked(operation: () -> T): T {
        var result: Result<T>? = null
        val run = { result = runCatching(operation) }
        try {
            resourceGate?.invoke(run) ?: run()
        } catch (error: Exception) {
            if (result == null) throw StaleResourceContext()
            throw error
        }
        return (result ?: throw StaleResourceContext()).getOrThrow()
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
                    val snapshot = snapshotForUrl(src) ?: snapshot(src, "font")
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

    val fontPath = object : LynxResourceProvider<Any, String>() {
        override fun request(
            request: com.lynx.tasm.provider.LynxResourceRequest<Any>,
            callback: com.lynx.tasm.provider.LynxResourceCallback<String>,
        ) {
            if (!owns(request.url)) {
                unmanagedFontPath?.let {
                    it.request(request, callback)
                    return
                }
                val delegate = unmanagedGeneric
                if (delegate == null) {
                    callback.onResponse(
                        com.lynx.tasm.provider.LynxResourceResponse.success<String>(
                            request.url,
                        ),
                    )
                    return
                }
                delegate.fetchResourcePath(
                    LynxResourceRequest(
                        request.url,
                        LynxResourceRequest.LynxResourceType.LynxResourceTypeFont,
                    ),
                    object : LynxResourceCallback<String> {
                        override fun onResponse(response: LynxResourceResponse<String>) {
                            callback.onResponse(
                                if (response.state == LynxResourceResponse.ResponseState.SUCCESS) {
                                    com.lynx.tasm.provider.LynxResourceResponse.success<String>(
                                        response.data,
                                    )
                                } else {
                                    com.lynx.tasm.provider.LynxResourceResponse.failed(
                                        -1,
                                        response.error,
                                    ) as com.lynx.tasm.provider.LynxResourceResponse<String>
                                },
                            )
                        }
                    },
                )
                return
            }
            try {
                tracked {
                    val snapshot = snapshotForUrl(request.url)
                        ?: snapshot(request.url, "font")
                    Typeface.createFromFile(snapshot.file)
                    callback.onResponse(
                        com.lynx.tasm.provider.LynxResourceResponse.success<String>(
                            snapshot.file.toLynxFileUri(),
                        ),
                    )
                    loaded("fontLoaded", snapshot)
                }
            } catch (error: Exception) {
                failed(error)
                callback.onResponse(
                    com.lynx.tasm.provider.LynxResourceResponse.failed(
                        -1,
                        error,
                    ) as com.lynx.tasm.provider.LynxResourceResponse<String>,
                )
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

    internal inner class ManagedImageLease(
        private val lease: AutoCloseable,
    ) : AutoCloseable {
        private val closed = AtomicBoolean()
        private var snapshot: Snapshot? = null

        fun prepare(url: String): String {
            check(snapshot == null) { "Managed image lease is already prepared" }
            val prepared = tracked {
                snapshotForUrl(url) ?: snapshot(url, "image")
            }
            snapshot = prepared
            return prepared.file.toLynxFileUri()
        }

        fun accept(consume: () -> Unit): Boolean {
            if (!isLive()) return false
            return try {
                tracked(consume)
                true
            } catch (_: StaleResourceContext) {
                false
            }
        }

        fun completeSuccess(consume: () -> Unit): Boolean = accept {
            consume()
            loaded("imageLoaded", checkNotNull(snapshot))
        }

        override fun close() {
            if (closed.compareAndSet(false, true)) lease.close()
        }
    }

    internal fun beginImage(): ManagedImageLease =
        ManagedImageLease(acquireAsynchronousLease())

    private fun snapshotForUrl(url: String): Snapshot? {
        val uri = runCatching { URI(url) }.getOrNull() ?: return null
        if (uri.scheme != "file" || !uri.authority.isNullOrEmpty()) return null
        val requested = File(requireNotNull(uri.path)).absoluteFile
        val file = requested.canonicalFile
        if (requested != file || !file.path.startsWith(snapshotRoot.path + "/")) {
            return null
        }
        val relative = file.relativeTo(snapshotRoot).invariantSeparatorsPath
        val expected = verifiedFileHashes[relative] ?: return null
        require(
            file.isFile && HashUtils.calculateSHA256(file)
                .equals(expected, ignoreCase = true),
        ) { "Managed resource snapshot changed: $relative" }
        return Snapshot(file, relative, expected.lowercase())
    }

    private fun acquireAsynchronousLease(): AutoCloseable {
        synchronized(leaseLock) {
            check(!closeRequested && isLive()) {
                "Native resource context is no longer live"
            }
            asynchronousLeases += 1
        }
        val released = AtomicBoolean()
        return AutoCloseable {
            if (!released.compareAndSet(false, true)) return@AutoCloseable
            val delete = synchronized(leaseLock) {
                asynchronousLeases -= 1
                check(asynchronousLeases >= 0)
                closeRequested && asynchronousLeases == 0
            }
            if (delete) deleteSnapshots()
        }
    }

    private fun deleteSnapshots() {
        synchronized(snapshotLock) {
            snapshotRoot.deleteRecursively()
        }
    }

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
            when {
                isManaged(url) -> OptionalBool.FALSE
                snapshotForUrl(url) != null -> OptionalBool.TRUE
                else -> OptionalBool.UNDEFINED
            }

        override fun shouldRedirectUrl(request: LynxResourceRequest): String = try {
            if (isRemote(request.url)) {
                request.url
            } else {
                tracked {
                    val snapshot = snapshotForUrl(request.url)
                        ?: snapshot(request.url, "image")
                    snapshot.file.toURI().toString()
                }
            }
        } catch (error: Exception) {
            failed(error)
            Log.e(
                "HotUpdaterLynx",
                "managed-resource-failure release=$releaseId url=${request.url}",
                error,
            )
            File(root, "hot-updater-lynx.json/.missing-resource")
                .toURI()
                .toString()
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

    val externalScript = object : LynxResourceProvider<Any, ByteArray>() {
        override fun request(
            request: com.lynx.tasm.provider.LynxResourceRequest<Any>,
            callback: com.lynx.tasm.provider.LynxResourceCallback<ByteArray>,
        ) {
            if (!owns(request.url)) {
                unmanagedExternalScript?.let {
                    it.request(request, callback)
                    return
                }
                val delegate = unmanagedGeneric
                if (delegate == null) {
                    callback.onResponse(
                        com.lynx.tasm.provider.LynxResourceResponse.failed(
                            -1,
                            IllegalArgumentException(
                                "Unmanaged external script requires a host resource fetcher",
                            ),
                        ) as com.lynx.tasm.provider.LynxResourceResponse<ByteArray>,
                    )
                    return
                }
                delegate.fetchResource(
                    LynxResourceRequest(
                        request.url,
                        LynxResourceRequest.LynxResourceType
                            .LynxResourceTypeExternalJSSource,
                    ),
                    object : LynxResourceCallback<ByteArray> {
                        override fun onResponse(response: LynxResourceResponse<ByteArray>) {
                            callback.onResponse(
                                if (response.state == LynxResourceResponse.ResponseState.SUCCESS) {
                                    com.lynx.tasm.provider.LynxResourceResponse.success<ByteArray>(
                                        response.data,
                                    )
                                } else {
                                    com.lynx.tasm.provider.LynxResourceResponse.failed(
                                        -1,
                                        response.error,
                                    ) as com.lynx.tasm.provider.LynxResourceResponse<ByteArray>
                                },
                            )
                        }
                    },
                )
                return
            }
            try {
                loadBytes(request.url) { bytes ->
                    callback.onResponse(
                        com.lynx.tasm.provider.LynxResourceResponse.success<ByteArray>(
                            bytes,
                        ),
                    )
                }
            } catch (error: Exception) {
                failed(error)
                callback.onResponse(
                    com.lynx.tasm.provider.LynxResourceResponse.failed(
                        -1,
                        error,
                    ) as com.lynx.tasm.provider.LynxResourceResponse<ByteArray>,
                )
            }
        }
    }

    internal fun configure(builder: LynxViewBuilder) {
        check(imageServiceRegistration == null) {
            "Native resource context is already configured"
        }
        imageServiceRegistration = ManagedLynxImageServices.acquire(this)
        configureBuilder(builder)
    }

    internal fun configureBuilder(builder: LynxViewBuilder) {
        @Suppress("UNCHECKED_CAST")
        unmanagedExternalScript = builder.lynxRuntimeOptions
            .getResourceProvidersByKey(
                LynxProviderRegistry.LYNX_PROVIDER_TYPE_EXTERNAL_JS,
            ) as? LynxResourceProvider<Any, ByteArray>
        @Suppress("UNCHECKED_CAST")
        unmanagedFontPath = builder.lynxRuntimeOptions.getResourceProvidersByKey(
            LynxProviderRegistry.LYNX_PROVIDER_TYPE_FONT,
        ) as? LynxResourceProvider<Any, String>
        builder.setTemplateProvider(object :
            com.lynx.tasm.provider.AbsTemplateProvider() {
            override fun loadTemplate(uri: String, callback: Callback) {
                try {
                    loadBytes(uri, callback::onSuccess)
                } catch (error: Exception) {
                    failed(error)
                    callback.onFailed(error.message)
                }
            }
        })
        builder.setTemplateResourceFetcher(template)
        builder.setResourceProvider(
            LynxProviderRegistry.LYNX_PROVIDER_TYPE_EXTERNAL_JS,
            externalScript,
        )
        builder.setResourceProvider(
            LynxProviderRegistry.LYNX_PROVIDER_TYPE_FONT,
            fontPath,
        )
    }

    internal fun bindImageContext(context: LynxContext) {
        checkNotNull(imageServiceRegistration).bind(context)
    }

    internal fun prepareForRebind() {
        imageServiceRegistration?.close()
        imageServiceRegistration = null
        onLoaded = null
        resourceGate = null
    }

    internal fun close() {
        imageServiceRegistration?.close()
        imageServiceRegistration = null
        val delete = synchronized(leaseLock) {
            closeRequested = true
            asynchronousLeases == 0
        }
        if (delete) deleteSnapshots()
    }
}

internal fun File.toLynxFileUri(): String =
    URI("file", "", absoluteFile.path, null, null).toASCIIString()
