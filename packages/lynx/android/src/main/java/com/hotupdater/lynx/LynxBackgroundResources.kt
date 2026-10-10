package com.hotupdater.lynx

import com.lynx.tasm.resourceprovider.LynxResourceCallback
import com.lynx.tasm.resourceprovider.LynxResourceRequest
import com.lynx.tasm.resourceprovider.LynxResourceResponse
import com.lynx.tasm.resourceprovider.generic.LynxGenericResourceFetcher
import com.lynx.tasm.resourceprovider.generic.StreamDelegate
import com.lynx.tasm.resourceprovider.template.LynxTemplateResourceFetcher
import com.lynx.tasm.resourceprovider.template.TemplateProviderResult

/** Task dependencies must be bundled into the authenticated script, never loaded from a moving installation. */
internal object LynxBackgroundResources {
    private const val MESSAGE = "Lynx background entries must be self-contained"

    @Suppress("UNCHECKED_CAST") // Lynx 3.9 declares onFailed as a raw generic; a failure contains no T.
    private fun <T> reject(callback: LynxResourceCallback<T>) {
        callback.onResponse(LynxResourceResponse.onFailed(IllegalStateException(MESSAGE)) as LynxResourceResponse<T>)
    }

    val generic = object : LynxGenericResourceFetcher() {
        override fun fetchResource(request: LynxResourceRequest, callback: LynxResourceCallback<ByteArray>) = reject(callback)
        override fun fetchResourcePath(request: LynxResourceRequest, callback: LynxResourceCallback<String>) = reject(callback)
        override fun fetchBytecode(request: LynxResourceRequest, callback: LynxResourceCallback<ByteArray>) = reject(callback)
        override fun fetchStream(request: LynxResourceRequest, delegate: StreamDelegate) = delegate.onError(MESSAGE)
    }

    val template = object : LynxTemplateResourceFetcher() {
        override fun fetchTemplate(request: LynxResourceRequest, callback: LynxResourceCallback<TemplateProviderResult>) = reject(callback)
        override fun fetchSSRData(request: LynxResourceRequest, callback: LynxResourceCallback<ByteArray>) = reject(callback)
    }
}
