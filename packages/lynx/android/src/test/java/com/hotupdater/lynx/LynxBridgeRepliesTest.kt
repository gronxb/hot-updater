package com.hotupdater.lynx

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LynxBridgeRepliesTest {
    @Test
    fun bridgeJsonPreservesNestedNullDeliveryFields() {
        val hash = "a".repeat(64)
        val bundleId = "018f0000-0000-7000-8000-000000000001"
        val baseBundleId = "018f0000-0000-7000-8000-000000000002"
        val json = lynxBridgeJson(
            mapOf(
                "bundleId" to bundleId,
                "fileUrl" to null,
                "fileHash" to null,
                "manifestUrl" to "https://example.test/manifest",
                "manifestFileHash" to hash,
                "changedAssets" to mapOf(
                    "main.lynx.bundle" to mapOf(
                        "fileHash" to hash,
                        "file" to null,
                        "patch" to mapOf(
                            "algorithm" to "bsdiff",
                            "baseBundleId" to baseBundleId,
                            "baseFileHash" to hash,
                            "patchFileHash" to hash,
                            "patchUrl" to "https://example.test/patch",
                        ),
                    ),
                ),
            ),
        )

        val changed = json.getJSONObject("changedAssets")
            .getJSONObject("main.lynx.bundle")
        assertTrue(changed.has("file"))
        assertTrue(changed.isNull("file"))
        assertEquals(bundleId, LynxArtifactRequest.fromJson(json).bundleId)
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
