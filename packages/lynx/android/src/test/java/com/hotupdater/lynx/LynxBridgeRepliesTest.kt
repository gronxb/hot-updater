package com.hotupdater.lynx

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LynxBridgeRepliesTest {
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
