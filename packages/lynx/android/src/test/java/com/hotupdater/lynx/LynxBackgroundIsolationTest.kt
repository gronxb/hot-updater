package com.hotupdater.lynx

import android.content.ContextWrapper
import com.lynx.jsbridge.IContextFinder
import com.lynx.jsbridge.IModuleCreator
import com.lynx.jsbridge.LynxModuleWrapper
import com.lynx.jsbridge.ParamWrapper
import com.lynx.tasm.resourceprovider.LynxResourceCallback
import com.lynx.tasm.resourceprovider.LynxResourceRequest
import com.lynx.tasm.resourceprovider.LynxResourceResponse
import com.lynx.tasm.resourceprovider.generic.StreamDelegate
import com.lynx.tasm.resourceprovider.template.TemplateProviderResult
import java.util.concurrent.ConcurrentHashMap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class LynxBackgroundIsolationTest {
    @Test fun moduleLookupNeverDelegatesForegroundOrGlobalApplicationModules() {
        val constructed = mutableListOf<String>()
        val delegate = object : IModuleCreator {
            override fun create(name: String, wrappers: ConcurrentHashMap<String, ParamWrapper>): LynxModuleWrapper? {
                constructed.add(name)
                return null
            }
            override fun currentContextFinder(): IContextFinder? = null
            override fun resetContextFinder(finder: IContextFinder) = Unit
            override fun destroy() = Unit
            override fun Type() = 0
        }
        val creator = LynxBackgroundModuleCreator(delegate)
        val registrations = ConcurrentHashMap<String, ParamWrapper>()
        for (name in listOf("HotUpdaterLynx", "LynxFetchModule", "GlobalApplicationModule", "HotUpdaterBackground")) {
            creator.create(name, registrations)
        }
        assertEquals(listOf("HotUpdaterBackground"), constructed)
    }

    @Test fun completionModuleKeepsItsNativeBindingAndAcceptsOnlyOneResult() {
        val first = mutableListOf<String>()
        val second = mutableListOf<String>()
        val context = ContextWrapper(null)
        val moduleA = HotUpdaterBackgroundModule(context, LynxBackgroundCompletionSink(first::add))
        val moduleB = HotUpdaterBackgroundModule(context, LynxBackgroundCompletionSink(second::add))
        moduleA.complete("computed-A")
        moduleA.complete("replacement-A")
        moduleB.complete("computed-B")
        assertEquals(listOf("computed-A"), first)
        assertEquals(listOf("computed-B"), second)
    }

    @Test fun additionalScriptPathsTemplatesBytecodeAndStreamsAlwaysFailClosed() {
        var failures = 0
        fun <T> callback() = object : LynxResourceCallback<T> {
            override fun onResponse(response: LynxResourceResponse<T>) {
                assertNotNull(response.error)
                assertNull(response.data)
                failures++
            }
        }
        for (url in listOf("file:///data/app/installed/task.js", "../other.js", "https://example.com/script.js")) {
            val request = LynxResourceRequest(url, LynxResourceRequest.LynxResourceType.LynxResourceTypeExternalJSSource)
            LynxBackgroundResources.generic.fetchResource(request, callback<ByteArray>())
            LynxBackgroundResources.generic.fetchResourcePath(request, callback<String>())
            LynxBackgroundResources.generic.fetchBytecode(request, callback<ByteArray>())
            LynxBackgroundResources.template.fetchTemplate(request, callback<TemplateProviderResult>())
            LynxBackgroundResources.template.fetchSSRData(request, callback<ByteArray>())
            LynxBackgroundResources.generic.fetchStream(request, object : StreamDelegate {
                override fun onStart(status: Int) { error("Unexpected stream") }
                override fun onData(data: ByteArray, offset: Int, length: Int) { error("Unexpected data") }
                override fun onEnd() { error("Unexpected success") }
                override fun onError(message: String) { failures++ }
            })
        }
        assertEquals(18, failures)
    }
}
