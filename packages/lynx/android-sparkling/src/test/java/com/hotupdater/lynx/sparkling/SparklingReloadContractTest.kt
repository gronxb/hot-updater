package com.hotupdater.lynx.sparkling

import com.hotupdater.lynx.LynxNativeOperationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class SparklingReloadContractTest {
    @Test
    fun closedBusyAndStaleRequestsNeverStartReplacement() {
        listOf(
            Triple(true, false, true) to "HOST_CLOSED",
            Triple(false, true, true) to "RELOAD_BUSY",
            Triple(false, false, false) to "CONTEXT_REJECTED",
        ).forEach { (state, code) ->
            var started = false
            val result = SparklingReloadContract.run(
                closed = state.first,
                replacing = state.second,
                current = state.third,
            ) {
                started = true
                Result.success(Unit)
            }
            assertFalse(started)
            assertEquals(
                code,
                (result.exceptionOrNull() as LynxNativeOperationException).code,
            )
        }
    }

    @Test
    fun replacementResultIsTheReloadResult() {
        val failure = LynxNativeOperationException(
            "RECONSTRUCTION_FAILED",
            "attach failed",
        )
        val failed = SparklingReloadContract.run(false, false, true) {
            Result.failure(failure)
        }
        assertEquals(failure, failed.exceptionOrNull())

        val succeeded = SparklingReloadContract.run(false, false, true) {
            Result.success(Unit)
        }
        assertEquals(Unit, succeeded.getOrThrow())
    }
}
