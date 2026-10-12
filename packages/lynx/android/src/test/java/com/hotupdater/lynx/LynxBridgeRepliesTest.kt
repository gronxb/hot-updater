package com.hotupdater.lynx

import com.lynx.react.bridge.JavaOnlyMap
import com.lynx.react.bridge.ReadableMap
import java.lang.reflect.Proxy
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class LynxBridgeRepliesTest {
    @Test
    fun bridgeJsonPreservesNestedNullDeliveryFields() {
        val hash = "a".repeat(64)
        val bundleId = "018f0000-0000-7000-8000-000000000001"
        val baseBundleId = "018f0000-0000-7000-8000-000000000002"
        val patch = JavaOnlyMap.from(
            mapOf(
                "algorithm" to "bsdiff",
                "baseBundleId" to baseBundleId,
                "baseFileHash" to hash,
                "patchFileHash" to hash,
                "patchUrl" to "https://example.test/patch",
            ),
        )
        val bridgeChangedAsset = JavaOnlyMap.from(
            mapOf(
                "fileHash" to hash,
                "file" to JavaOnlyMap.from(mapOf("url" to "https://example.test/file", "compression" to null)),
                "patch" to patch,
            ),
        )
        val assets = JavaOnlyMap.from(
            mapOf("main.lynx.bundle" to bridgeChangedAsset),
        )
        val params = JavaOnlyMap.from(
            mapOf(
                "bundleId" to bundleId,
                "artifactProtocolVersion" to 1.0,
                "fileUrl" to null,
                "fileHash" to null,
                "manifestUrl" to "https://example.test/manifest",
                "manifestFileHash" to hash,
                "assets" to assets,
            ),
        )
        val lossyParams = Proxy.newProxyInstance(
            ReadableMap::class.java.classLoader,
            arrayOf(ReadableMap::class.java),
        ) { _, method, args ->
            if (method.name == "asHashMap") hashMapOf<String, Any>()
            else method.invoke(params, *(args ?: emptyArray()))
        } as ReadableMap
        val json = lynxBridgeJson(lossyParams)

        val changed = json.getJSONObject("assets")
            .getJSONObject("main.lynx.bundle")
        assertTrue(changed.getJSONObject("file").isNull("compression"))
        val parsed = LynxArtifactRequest.fromJson(json)
        assertEquals(bundleId, parsed.bundleId)
        assertNull(parsed.assets?.get("main.lynx.bundle")?.file?.compression)
        assertEquals(
            baseBundleId,
            parsed.assets?.get("main.lynx.bundle")?.patch?.baseBundleId,
        )

        changed.remove("file")
        assertThrows(IllegalArgumentException::class.java) {
            LynxArtifactRequest.fromJson(json)
        }

        val rawChanged = JSONObject()
            .put("fileHash", hash)
            .put("file", JSONObject().put("url", "https://example.test/file"))
        json.getJSONObject("assets").put("main.lynx.bundle", rawChanged)
        val rawParsed = LynxArtifactRequest.fromJson(json)
            .assets?.get("main.lynx.bundle")
        assertNull(rawParsed?.file?.compression)
        assertNull(rawParsed?.patch)
    }

    @Test
    fun acceptedReplyWaitsForCompletionAndSettlesOnlyOnce() {
        var reply: Result<String>? = null
        val once = LynxOnceReply<String> { reply = it }

        assertNull(reply)
        once.settle(Result.success("replaced"))
        once.settle(Result.failure(IllegalStateException("late")))

        assertEquals("replaced", reply?.getOrThrow())
    }

    @Test
    fun generationCloseRejectsEveryPendingReplyExactlyOnce() {
        val replies = LynxBridgeReplies()
        val observed = mutableListOf<Result<JSONObject>>()
        val ticket = checkNotNull(replies.register(observed::add))

        replies.close()
        replies.close()
        replies.settle(ticket, Result.success(JSONObject()))

        assertEquals(1, observed.size)
        assertEquals(
            "CONTEXT_REJECTED",
            (observed.single().exceptionOrNull() as LynxNativeOperationException).code,
        )
    }

    @Test
    fun closedGenerationRejectsNewRepliesImmediately() {
        val replies = LynxBridgeReplies()
        var result: Result<JSONObject>? = null
        replies.close()

        val ticket = replies.register { result = it }

        assertNull(ticket)
        assertEquals(
            "CONTEXT_REJECTED",
            (result?.exceptionOrNull() as LynxNativeOperationException).code,
        )
    }
}
