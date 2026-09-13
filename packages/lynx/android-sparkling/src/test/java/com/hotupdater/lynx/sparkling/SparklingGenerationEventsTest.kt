package com.hotupdater.lynx.sparkling

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SparklingGenerationEventsTest {
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
