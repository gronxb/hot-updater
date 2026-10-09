package com.hotupdater.lynx

import java.io.IOException
import java.util.concurrent.CancellationException
import java.util.concurrent.TimeoutException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LynxBackgroundLifecycleTest {
    private class Runtime {
        var destroyRequests = 0
        var releases = 0
        val failures = mutableListOf<String>()
        val replies = mutableListOf<Result<String>>()
        var writeError: Throwable? = null
        val lifecycle = LynxBackgroundLifecycle(
            destroy = { destroyRequests++ },
            persistFatal = { message -> failures.add(message); writeError?.let { throw it } },
            release = { releases++; writeError?.let { throw it } },
            reply = replies::add,
        )
    }

    @Test fun completionWaitsForNativeDetachAndDuplicateCompletionsCannotReplaceIt() {
        val runtime = Runtime()
        runtime.lifecycle.complete("deployed-A")
        runtime.lifecycle.complete("forged-B")
        assertEquals(1, runtime.destroyRequests)
        assertEquals(0, runtime.releases)
        assertTrue(runtime.replies.isEmpty())
        runtime.lifecycle.onDetached()
        runtime.lifecycle.onDetached()
        runtime.lifecycle.complete("after-detach")
        assertEquals(1, runtime.releases)
        assertEquals(listOf("deployed-A"), runtime.replies.map { it.getOrThrow() })
    }

    @Test fun fatalAfterCompletionOverridesSuccessBeforeDetach() {
        val runtime = Runtime()
        runtime.lifecycle.complete("computed-A")
        val error = IllegalStateException("native fatal")
        runtime.lifecycle.nativeError(error, true)
        assertEquals(listOf("native fatal"), runtime.failures)
        assertEquals(0, runtime.releases)
        assertTrue(runtime.replies.isEmpty())
        runtime.lifecycle.onDetached()
        assertEquals(error, runtime.replies.single().exceptionOrNull())
        assertEquals(1, runtime.destroyRequests)
    }

    @Test fun timeoutAndCancellationReplyOnceButRetainEngineUntilDetach() {
        for (error in listOf(TimeoutException("deadline"), CancellationException("cancelled"))) {
            val runtime = Runtime()
            runtime.lifecycle.stop(error)
            runtime.lifecycle.complete("too-late")
            runtime.lifecycle.stop(error)
            assertEquals(0, runtime.releases)
            assertEquals(1, runtime.destroyRequests)
            assertEquals(error, runtime.replies.single().exceptionOrNull())
            // Cancellation cannot erase a fatal already produced by the still-live engine.
            runtime.lifecycle.nativeError(IllegalStateException("queued fatal"), true)
            assertEquals(listOf("queued fatal"), runtime.failures)
            runtime.lifecycle.onDetached()
            assertEquals(1, runtime.releases)
            assertEquals(1, runtime.replies.size)
        }
    }

    @Test fun failedFatalPersistenceDoesNotBecomeSuccessOrThrowAwayNativeOwnership() {
        val runtime = Runtime()
        val disk = IOException("fsync failed")
        runtime.writeError = disk
        val fatal = IllegalStateException("runtime fatal")
        runtime.lifecycle.nativeError(fatal, true)
        assertEquals(listOf(disk), fatal.suppressed.toList())
        assertEquals(0, runtime.releases)
        assertTrue(runtime.replies.isEmpty())
        runtime.lifecycle.onDetached()
        assertEquals(disk, runtime.replies.single().exceptionOrNull())
        assertEquals(listOf("runtime fatal"), runtime.failures)
    }

    @Test fun nonfatalErrorAndMissingCompletionDoNotQuarantineArtifact() {
        val runtime = Runtime()
        val error = IllegalStateException("engine initialization error")
        runtime.lifecycle.nativeError(error, false)
        runtime.lifecycle.onDetached()
        assertTrue(runtime.failures.isEmpty())
        assertEquals(error, runtime.replies.single().exceptionOrNull())
        val detached = Runtime()
        detached.lifecycle.onDetached()
        assertTrue(detached.replies.single().isFailure)
        assertTrue(detached.failures.isEmpty())
        assertEquals(0, detached.destroyRequests)
    }

    @Test fun oversizedBridgeResultAndMissingDetachCannotReportSuccess() {
        val runtime = Runtime()
        runtime.lifecycle.complete("x".repeat(16 * 1024 + 1))
        assertTrue(runtime.replies.single().isFailure)
        assertEquals(0, runtime.releases)
        val pending = Runtime()
        pending.lifecycle.complete("A")
        pending.lifecycle.stop(TimeoutException("detach never arrived"))
        assertFalse(pending.replies.single().isSuccess)
        assertEquals(0, pending.releases)
        assertEquals(1, pending.destroyRequests)
    }

    @Test fun destroyFailureRetainsReservationAndCannotReplyTwice() {
        val replies = mutableListOf<Result<String>>()
        var releases = 0
        val error = IllegalStateException("destroy failed")
        val lifecycle = LynxBackgroundLifecycle(
            destroy = { throw error }, persistFatal = {}, release = { releases++ }, reply = replies::add,
        )
        lifecycle.complete("A")
        assertEquals(error, replies.single().exceptionOrNull())
        assertEquals(0, releases)
        lifecycle.onDetached()
        assertEquals(1, releases)
        assertEquals(1, replies.size)
    }
}
