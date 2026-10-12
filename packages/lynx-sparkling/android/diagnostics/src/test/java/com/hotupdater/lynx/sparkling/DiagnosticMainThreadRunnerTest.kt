package com.hotupdater.lynx.sparkling

import android.os.Looper
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DiagnosticMainThreadRunnerTest {
    @Test
    fun backgroundBridgeCallRunsHostActionAndSettlesOnceOnMain() {
        val runner = DiagnosticMainThreadRunner()
        val posted = CountDownLatch(1)
        val callbacks = AtomicInteger()
        var operationRanOnMain = false
        var callbackRanOnMain = false
        var callbackValue: String? = null
        val executor = Executors.newSingleThreadExecutor()
        try {
            executor.execute {
                runner.run<String>(
                    callback = { result ->
                        callbacks.incrementAndGet()
                        callbackRanOnMain =
                            Looper.myLooper() == Looper.getMainLooper()
                        callbackValue = result.getOrThrow()
                    },
                    operation = { completion ->
                        operationRanOnMain =
                            Looper.myLooper() == Looper.getMainLooper()
                        completion(Result.success("accepted"))
                        completion(Result.failure(
                            IllegalStateException("late failure"),
                        ))
                    },
                )
                posted.countDown()
            }
            assertTrue(posted.await(5, TimeUnit.SECONDS))
            shadowOf(Looper.getMainLooper()).idle()

            assertTrue(operationRanOnMain)
            assertTrue(callbackRanOnMain)
            assertEquals("accepted", callbackValue)
            assertEquals(1, callbacks.get())
        } finally {
            executor.shutdownNow()
        }
    }
}
