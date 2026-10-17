package com.hotupdater

import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class CohortServiceTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `instances that read the cohort at once share the one they create`() {
        val pool = Executors.newFixedThreadPool(8)
        try {
            repeat(50) {
                // No ANDROID_ID, so the cohort comes from a created fallback identifier.
                val context = InstanceTestContext(temporaryFolder.newFolder())
                val start = CountDownLatch(1)
                val cohorts =
                    (0 until 8).map {
                        pool.submit<String> {
                            val service = CohortService(context)
                            start.await()
                            service.getCohort()
                        }
                    }
                start.countDown()
                assertEquals(1, cohorts.map { it.get(10, TimeUnit.SECONDS) }.toSet().size)
            }
        } finally {
            pool.shutdownNow()
        }
    }
}
