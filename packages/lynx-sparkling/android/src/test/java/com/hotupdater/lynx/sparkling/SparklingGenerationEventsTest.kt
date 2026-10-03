package com.hotupdater.lynx.sparkling

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SparklingGenerationEventsTest {
    private val identity = mapOf<String, Any?>(
        "runtimeId" to "runtime-a",
        "processId" to "1234",
        "generationId" to "generation-a",
        "bundleId" to "bundle-a",
        "releaseId" to null,
        "contextId" to "context-a",
        "pageAttemptId" to null,
        "transitionId" to null,
    )

    @Test
    fun terminalEmissionIsAcknowledgedOnlyAfterDurableAppend() {
        val observed = mutableListOf<String>()
        val sink = SparklingRuntimeEventSink(
            record = { _, _ -> Unit },
            recordOnce = { _, _, _, _ -> error("injected journal failure") },
            listener = HotUpdaterSparklingEventListener { name, _ ->
                observed += name
            },
        )
        val generation = SparklingGenerationEvents(sink, id = "generation-a")

        assertFalse(generation.emitTerminal(
            identity + mapOf(
                "pageAttemptId" to "page-a",
                "terminal" to "admitted",
            ),
        ))
        assertEquals(listOf("pageAttemptTerminal"), observed)
    }

    @Test
    fun throwingOptionalObserverCannotInterruptNormalOrTerminalEmission() {
        val persisted = mutableListOf<String>()
        val sink = SparklingRuntimeEventSink(
            record = { name, _ -> persisted += name },
            recordOnce = { name, _, _, _ -> persisted += name; true },
            listener = HotUpdaterSparklingEventListener { _, _ ->
                error("injected observer failure")
            },
        )
        val generation = SparklingGenerationEvents(sink, id = "generation-a")

        assertTrue(generation.emit("routeClosed", identity))
        assertTrue(generation.emitTerminal(
            identity + mapOf(
                "pageAttemptId" to "page-a",
                "terminal" to "authorized-cancel",
            ),
        ))
        assertEquals(listOf("routeClosed", "pageAttemptTerminal"), persisted)
    }

    @Test
    fun throwingDirectListenerCannotInterruptAcceptedLifecycleProgress() {
        val observed = mutableListOf<String>()
        val generation = SparklingGenerationEvents(
            HotUpdaterSparklingEventListener { name, _ ->
                observed += name
                error("injected observer failure")
            },
            id = "generation-a",
        )
        val resource = mapOf<String, Any?>(
            "contextId" to "context-a",
            "path" to "assets/bootstrap.js",
        )

        assertTrue(generation.emit("pageAdmitted", emptyMap()))
        assertTrue(generation.resourceLoaded("resourceLoaded", resource))
        assertTrue(generation.emit("routeClosed", emptyMap()))
        assertTrue(generation.emitTerminal(
            mapOf(
                "pageAttemptId" to "page-a",
                "terminal" to "authorized-cancel",
            ),
        ))
        generation.beginRetirement(mapOf("reason" to "reload"))
        generation.finishRetirement(mapOf("reason" to "reload"))

        assertEquals(
            listOf(
                "pageAdmitted",
                "resourceLeaseAcquired",
                "resourceLoaded",
                "routeClosed",
                "pageAttemptTerminal",
                "generationWillRetire",
                "resourceLeaseReleased",
                "generationRetired",
            ),
            observed,
        )
        assertFalse(generation.emit("late", emptyMap()))
    }

    @Test
    fun nilExternalListenerStillPersistsNativeGenerationEvidence() {
        val recorded = mutableListOf<Pair<String, Map<String, Any?>>>()
        val generation = SparklingGenerationEvents(
            SparklingRuntimeEventSink(
                { name, details -> recorded += name to details },
                null,
            ),
            id = "generation-a",
        )

        assertTrue(generation.emit(
            "generationStarted",
            identity + mapOf(
                "nativePageClass" to
                    "com.hotupdater.lynx.sparkling.HotUpdaterSparklingPageActivity",
                "orderedPageEntries" to listOf(
                    "main.lynx.bundle",
                    "detail.lynx.bundle",
                ),
                "topPageEntry" to "detail.lynx.bundle",
            ),
        ))

        assertEquals(listOf("generationStarted"), recorded.map { it.first })
        assertEquals(
            "generation-a",
            recorded.single().second["generationId"],
        )
        assertEquals(
            "detail.lynx.bundle",
            recorded.single().second["topPageEntry"],
        )
    }

    @Test
    fun runtimeSinkPersistsOnlyTheExactStringIdentityDomain() {
        val recorded = mutableListOf<String>()
        val sink = SparklingRuntimeEventSink(
            record = { name, _ -> recorded += name },
            listener = null,
        )

        sink.onEvent("valid", identity)
        sink.onEvent("numericProcess", identity + ("processId" to 1234))
        sink.onEvent("missingTransition", identity - "transitionId")

        assertEquals(listOf("valid"), recorded)
    }

    @Test
    fun retirementWaitsForTheRealResourceConsumerToFinish() {
        val events = mutableListOf<Pair<String, Map<String, Any?>>>()
        val generation = SparklingGenerationEvents(
            HotUpdaterSparklingEventListener { name, details ->
                events += name to details
            },
            id = "generation-a",
        )
        val consumerStarted = CountDownLatch(1)
        val releaseConsumer = CountDownLatch(1)
        val retired = CountDownLatch(1)
        val resource = thread(start = true) {
            generation.resourceOperation {
                consumerStarted.countDown()
                check(releaseConsumer.await(2, TimeUnit.SECONDS))
                generation.resourceLoaded(
                    "resourceLoaded",
                    mapOf(
                        "contextId" to "context-a",
                        "path" to "assets/bootstrap.js",
                        "sha256" to "abc",
                    ),
                )
            }
        }
        assertTrue(consumerStarted.await(2, TimeUnit.SECONDS))
        val retirement = thread(start = true) {
            val details = mapOf<String, Any?>(
                "generationId" to "generation-a",
            )
            generation.beginRetirement(details)
            generation.finishRetirement(details)
            retired.countDown()
        }

        assertFalse(retired.await(100, TimeUnit.MILLISECONDS))
        releaseConsumer.countDown()
        assertTrue(retired.await(2, TimeUnit.SECONDS))
        resource.join()
        retirement.join()
        assertEquals(
            listOf(
                "resourceLeaseAcquired",
                "resourceLoaded",
                "generationWillRetire",
                "resourceLeaseReleased",
                "generationRetired",
            ),
            events.map(Pair<String, Map<String, Any?>>::first),
        )
        assertEquals(0, events.last().second["inFlightResourceCount"])
    }

    @Test
    fun retirementReleasesLeasesBeforeCompletionAndRejectsLateEvents() {
        val events = mutableListOf<Pair<String, Map<String, Any?>>>()
        val generation = SparklingGenerationEvents(
            HotUpdaterSparklingEventListener { name, details ->
                events += name to details
            },
            id = "generation-a",
        )
        val resource = mapOf<String, Any?>(
            "contextId" to "context-a",
            "path" to "assets/probe.png",
            "sha256" to "abc",
        )
        assertTrue(generation.emit("generationWillEvaluate", emptyMap()))
        assertTrue(generation.resourceLoaded("resourceLoaded", resource))
        assertTrue(generation.resourceLoaded(
            "imageLoaded",
            resource + ("contextId" to "context-b"),
        ))

        val releaseObserver = CountDownLatch(1)
        val observerDone = CountDownLatch(1)
        var lateAccepted = true
        val observer = thread(start = true) {
            releaseObserver.await()
            lateAccepted = generation.resourceLoaded(
                "resourceLoaded",
                resource + ("sha256" to "late"),
            )
            observerDone.countDown()
        }
        val retired = mapOf<String, Any?>("generationId" to "generation-a")
        generation.beginRetirement(retired)
        releaseObserver.countDown()
        assertTrue(observerDone.await(2, TimeUnit.SECONDS))
        generation.finishRetirement(retired)
        observer.join()

        assertFalse(lateAccepted)
        assertEquals(
            listOf(
                "generationWillEvaluate",
                "resourceLeaseAcquired",
                "resourceLoaded",
                "resourceLeaseAcquired",
                "imageLoaded",
                "generationWillRetire",
                "resourceLeaseReleased",
                "resourceLeaseReleased",
                "generationRetired",
            ),
            events.map(Pair<String, Map<String, Any?>>::first),
        )
        assertEquals("context-a", events[6].second["contextId"])
        assertEquals("context-b", events[7].second["contextId"])
        assertEquals(0, events.last().second["inFlightResourceCount"])
    }
}
