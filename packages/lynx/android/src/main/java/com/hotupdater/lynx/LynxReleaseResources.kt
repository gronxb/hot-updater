package com.hotupdater.lynx

import android.net.Uri
import android.graphics.Typeface
import com.lynx.tasm.behavior.LynxContext
import com.lynx.tasm.fontface.FontFace
import com.lynx.tasm.loader.LynxFontFaceLoader
import android.util.Log
import com.lynx.tasm.provider.AbsTemplateProvider
import com.lynx.tasm.resourceprovider.LynxResourceCallback
import com.lynx.tasm.resourceprovider.LynxResourceRequest
import com.lynx.tasm.resourceprovider.LynxResourceResponse
import com.lynx.tasm.resourceprovider.generic.LynxGenericResourceFetcher
import com.lynx.tasm.resourceprovider.media.LynxMediaResourceFetcher
import com.lynx.tasm.resourceprovider.media.OptionalBool
import com.lynx.tasm.resourceprovider.template.LynxTemplateResourceFetcher
import com.lynx.tasm.resourceprovider.template.TemplateProviderResult
import java.io.File
import com.hotupdater.lynx.internal.HashUtils

/** Resource requests stay pinned to a verified installation for the context lifetime. */
class LynxReleaseResources(val root: File, val releaseId: String, val verifiedPaths: Set<String>) {
    internal var isLive: () -> Boolean = { true }
    internal var unmanagedGeneric: LynxGenericResourceFetcher? = null
    internal var unmanagedTemplate: LynxTemplateResourceFetcher? = null
    var fontLoaded = false
    internal val loadedFonts = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    var onFontLoaded: (() -> Unit)? = null
    var onFailure: ((String) -> Unit)? = null
    private fun isRemote(url: String): Boolean = Uri.parse(url).scheme in setOf("http", "https")
    private fun failed(error: Exception) { onFailure?.invoke(error.message ?: "Managed resource failure") }
    val font = object : LynxFontFaceLoader.Loader() {
        override fun onLoadFontFace(context: LynxContext, type: FontFace.TYPE, src: String): Typeface? {
            if (isRemote(src)) return null
            return try {
                val file = resolve(src)
                Typeface.createFromFile(file).also {
                    fontLoaded = true
                    loadedFonts.add(file.relativeTo(root.canonicalFile).invariantSeparatorsPath)
                    Log.i("HotUpdaterLynx", "font-loaded release=$releaseId sha256=${HashUtils.calculateSHA256(file)}")
                    onFontLoaded?.invoke()
                }
            } catch (error: Exception) {
                failed(error)
                Log.e("HotUpdaterLynx", "font-failed release=$releaseId src=$src", error)
                null
            }
        }
    }
    fun resolve(url: String, purpose: String = "resource"): File {
        check(isLive()) { "Native resource context is no longer live" }
        val relative = if (url.startsWith("hot-updater:///")) {
            val uri = Uri.parse(url)
            require(uri.authority.isNullOrEmpty() && uri.query == null && uri.fragment == null) { "Invalid managed URL" }
            requireNotNull(uri.path).removePrefix("/")
        } else {
            val uri = Uri.parse(url)
            require(uri.scheme == "file" && uri.authority.isNullOrEmpty()) { "Unsupported managed URL: $url" }
            val file = File(requireNotNull(uri.path)).absoluteFile
            require(file.path.startsWith(root.canonicalPath + "/")) { "Resource outside release: $url" }
            file.relativeTo(root.canonicalFile).invariantSeparatorsPath
        }
        require(!relative.contains('\\') && !relative.contains('\u0000') && relative.isNotBlank() && relative.split('/').none { it == ".." || it == "." || it.isEmpty() }) { "Invalid resource path: $url" }
        require(verifiedPaths.contains(relative)) { "Resource is not in the verified manifest: $url" }
        val requested = File(root.canonicalFile, relative).absoluteFile
        val file = requested.canonicalFile
        require(requested == file) { "Symbolic links are not allowed: $url" }
        require(file.path.startsWith(root.canonicalPath + "/") && file.isFile) { "Missing managed resource: $url" }
        Log.i("HotUpdaterLynx", "$purpose release=$releaseId url=$url path=${file.path} sha256=${HashUtils.calculateSHA256(file)}")
        return file
    }

    val media = object : LynxMediaResourceFetcher() {
        override fun isLocalResource(url: String): OptionalBool = if (url.startsWith("hot-updater:///")) OptionalBool.TRUE else OptionalBool.UNDEFINED
        override fun shouldRedirectUrl(request: LynxResourceRequest): String = try {
            if (isRemote(request.url)) request.url else Uri.fromFile(resolve(request.url)).toString()
        } catch (error: Exception) {
            failed(error)
            Log.e("HotUpdaterLynx", "managed-resource-failure release=$releaseId url=${request.url}", error)
            // The verified metadata is a regular file, so its child cannot exist even in hostile output.
            Uri.fromFile(File(root, "hot-updater-lynx.json/.missing-resource")).toString()
        }
    }
    val template = object : LynxTemplateResourceFetcher() {
        override fun fetchTemplate(request: LynxResourceRequest, callback: LynxResourceCallback<TemplateProviderResult>) {
            if (isRemote(request.url)) { val delegate = unmanagedTemplate; if (delegate != null) delegate.fetchTemplate(request, callback) else callback.onResponse(LynxResourceResponse.onFailed(IllegalArgumentException("Unmanaged template requires a host resource fetcher")) as LynxResourceResponse<TemplateProviderResult>); return }
            try { callback.onResponse(LynxResourceResponse.onSuccess(TemplateProviderResult.fromBinary(resolve(request.url).readBytes()))) }
            catch (error: Exception) { failed(error); callback.onResponse(LynxResourceResponse.onFailed(error) as LynxResourceResponse<TemplateProviderResult>) }
        }
        override fun fetchSSRData(request: LynxResourceRequest, callback: LynxResourceCallback<ByteArray>) {
            callback.onResponse(LynxResourceResponse.onFailed(IllegalArgumentException("SSR is not in the fixture contract")) as LynxResourceResponse<ByteArray>)
        }
    }
    val generic = object : LynxGenericResourceFetcher() {
        override fun fetchResource(request: LynxResourceRequest, callback: LynxResourceCallback<ByteArray>) {
            if (isRemote(request.url)) { val delegate = unmanagedGeneric; if (delegate != null) delegate.fetchResource(request, callback) else callback.onResponse(LynxResourceResponse.onFailed(IllegalArgumentException("Unmanaged resource requires a host resource fetcher")) as LynxResourceResponse<ByteArray>); return }
            try { callback.onResponse(LynxResourceResponse.onSuccess(resolve(request.url).readBytes())) }
            catch (error: Exception) { failed(error); callback.onResponse(LynxResourceResponse.onFailed(error) as LynxResourceResponse<ByteArray>) }
        }
        override fun fetchResourcePath(request: LynxResourceRequest, callback: LynxResourceCallback<String>) {
            if (isRemote(request.url)) { val delegate = unmanagedGeneric; if (delegate != null) delegate.fetchResourcePath(request, callback) else callback.onResponse(LynxResourceResponse.onFailed(IllegalArgumentException("Unmanaged resource requires a host resource fetcher")) as LynxResourceResponse<String>); return }
            try { callback.onResponse(LynxResourceResponse.onSuccess(resolve(request.url).path)) }
            catch (error: Exception) { failed(error); callback.onResponse(LynxResourceResponse.onFailed(error) as LynxResourceResponse<String>) }
        }
    }
}
