package com.hotupdater.lynxexample

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
import java.security.MessageDigest

internal fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

/** The spike maps compiler-owned asset URLs to immutable per-release disk paths. */
class ReleaseResources(val root: File, val releaseId: String, val verifiedPaths: Set<String>) {
    var fontLoaded = false
    var onFontLoaded: (() -> Unit)? = null
    var onFailure: ((String) -> Unit)? = null
    private fun failed(error: Exception) { onFailure?.invoke(error.message ?: "Managed resource failure") }
    val font = object : LynxFontFaceLoader.Loader() {
        override fun onLoadFontFace(context: LynxContext, type: FontFace.TYPE, src: String): Typeface? {
            return try {
                val file = resolve(src)
                Typeface.createFromFile(file).also {
                    fontLoaded = true
                    Log.i("HotUpdaterLynxG1", "font-loaded release=$releaseId sha256=${sha256(file.readBytes())}")
                    onFontLoaded?.invoke()
                }
            } catch (error: Exception) {
                failed(error)
                Log.e("HotUpdaterLynxG1", "font-failed release=$releaseId src=$src", error)
                null
            }
        }
    }
    fun resolve(url: String, purpose: String = "resource"): File {
        val relative = if (url.startsWith("hot-updater:///")) url.removePrefix("hot-updater:///") else if (url.startsWith("asset:///")) url.removePrefix("asset:///") else {
            val uri = Uri.parse(url)
            require(uri.scheme == "file" && uri.authority.isNullOrEmpty()) { "Unsupported managed URL: $url" }
            val file = File(requireNotNull(uri.path)).absoluteFile
            require(file.path.startsWith(root.canonicalPath + "/")) { "Resource outside release: $url" }
            file.relativeTo(root.canonicalFile).invariantSeparatorsPath
        }
        require(relative.isNotBlank() && relative.split('/').none { it == ".." || it == "." || it.isEmpty() }) { "Invalid resource path: $url" }
        require(verifiedPaths.contains(relative)) { "Resource is not in the verified manifest: $url" }
        val requested = File(root.canonicalFile, relative).absoluteFile
        val file = requested.canonicalFile
        require(requested == file) { "Symbolic links are not allowed: $url" }
        require(file.path.startsWith(root.canonicalPath + "/") && file.isFile) { "Missing managed resource: $url" }
        Log.i("HotUpdaterLynxG1", "$purpose release=$releaseId url=$url path=${file.path} sha256=${sha256(file.readBytes())}")
        return file
    }

    val media = object : LynxMediaResourceFetcher() {
        override fun isLocalResource(url: String): OptionalBool = if (url.startsWith("hot-updater:///")) OptionalBool.TRUE else OptionalBool.UNDEFINED
        override fun shouldRedirectUrl(request: LynxResourceRequest): String = try {
            Uri.fromFile(resolve(request.url)).toString()
        } catch (error: Exception) {
            failed(error)
            Log.e("HotUpdaterLynxG1", "managed-resource-failure release=$releaseId url=${request.url}", error)
            // A guaranteed missing file remains release-scoped and cannot hit embedded/network fallback.
            Uri.fromFile(File(root, ".missing-resource")).toString()
        }
    }
    val template = object : LynxTemplateResourceFetcher() {
        override fun fetchTemplate(request: LynxResourceRequest, callback: LynxResourceCallback<TemplateProviderResult>) {
            try { callback.onResponse(LynxResourceResponse.onSuccess(TemplateProviderResult.fromBinary(resolve(request.url).readBytes()))) }
            catch (error: Exception) { failed(error); callback.onResponse(LynxResourceResponse.onFailed(error) as LynxResourceResponse<TemplateProviderResult>) }
        }
        override fun fetchSSRData(request: LynxResourceRequest, callback: LynxResourceCallback<ByteArray>) {
            callback.onResponse(LynxResourceResponse.onFailed(IllegalArgumentException("SSR is not in the fixture contract")) as LynxResourceResponse<ByteArray>)
        }
    }
    val generic = object : LynxGenericResourceFetcher() {
        override fun fetchResource(request: LynxResourceRequest, callback: LynxResourceCallback<ByteArray>) {
            try { callback.onResponse(LynxResourceResponse.onSuccess(resolve(request.url).readBytes())) }
            catch (error: Exception) { failed(error); callback.onResponse(LynxResourceResponse.onFailed(error) as LynxResourceResponse<ByteArray>) }
        }
        override fun fetchResourcePath(request: LynxResourceRequest, callback: LynxResourceCallback<String>) {
            try { callback.onResponse(LynxResourceResponse.onSuccess(resolve(request.url).path)) }
            catch (error: Exception) { failed(error); callback.onResponse(LynxResourceResponse.onFailed(error) as LynxResourceResponse<String>) }
        }
    }
}

class ReleaseTemplateProvider : AbsTemplateProvider() {
    override fun loadTemplate(uri: String, callback: Callback) {
        try {
            val resources = requireNotNull(SpikeRegistry.resources) { "No process release selected" }
            callback.onSuccess(resources.resolve(uri).readBytes())
        } catch (error: Exception) { callback.onFailed(error.message) }
    }
}
