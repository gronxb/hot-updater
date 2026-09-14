package com.hotupdater.lynx.sparkling

import com.hotupdater.lynx.LynxGenerationEventJournal
import java.nio.file.Files
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeJournalDiagnosticsTest {
    private fun diagnostics(root: java.io.File) =
        RuntimeJournalDiagnostics(root) { "4321" }

    @Test
    fun retentionAndCountPlusOneExerciseTheProductionEvictionPath() {
        val root = Files.createTempDirectory("journal-diagnostics-").toFile()
        try {
            val diagnostics = diagnostics(root)
            diagnostics.install("retention-limit")
            val exact = diagnostics.receipt()
            assertEquals(
                LynxGenerationEventJournal.CAPACITY,
                exact.getJSONObject("snapshot").getJSONArray("events").length(),
            )
            assertFalse(exact.getJSONObject("snapshot").getBoolean("truncated"))
            assertEquals("4321", exact.getString("processId"))
            assertEquals(
                "synthetic-fixture",
                exact.getJSONObject("snapshot").getJSONArray("events")
                    .getJSONObject(0).getJSONObject("details")
                    .getString("identitySource"),
            )

            diagnostics.install("count-plus-one")
            diagnostics.append()
            val evicted = diagnostics.receipt().getJSONObject("snapshot")
            assertEquals("2", evicted.getString("oldestSequence"))
            assertEquals("257", evicted.getString("latestSequence"))
            assertTrue(evicted.getBoolean("truncated"))
            assertEquals(256, evicted.getJSONArray("events").length())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun bytePlusOneEvictsBeforePersistingTheAcceptedAppend() {
        val root = Files.createTempDirectory("journal-diagnostics-").toFile()
        try {
            val diagnostics = diagnostics(root)
            diagnostics.install("byte-plus-one")
            diagnostics.append()
            val receipt = diagnostics.receipt()
            assertTrue(receipt.getInt("byteLength") <= 16 * 1024 * 1024)
            assertTrue(receipt.getJSONObject("snapshot").getBoolean("truncated"))
            assertEquals(
                "257",
                receipt.getJSONObject("snapshot").getString("latestSequence"),
            )
            assertEquals(JSONObject.NULL, receipt.get("canonicalUtf8"))
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun invalidPersistedFixturesRepairToTheExactClosedState() {
        val root = Files.createTempDirectory("journal-diagnostics-").toFile()
        try {
            val diagnostics = diagnostics(root)
            listOf("corrupt-json", "noncanonical", "already-oversized").forEach {
                mode ->
                diagnostics.install(mode)
                diagnostics.reopen()
                val receipt = diagnostics.receipt()
                val snapshot = receipt.getJSONObject("snapshot")
                assertTrue(snapshot.getBoolean("truncated"))
                assertEquals(0, snapshot.getJSONArray("events").length())
                assertEquals(
                    "{\"events\":[],\"nextSequence\":\"1\"," +
                        "\"schemaVersion\":1,\"truncated\":true}",
                    receipt.getString("canonicalUtf8"),
                )
            }
            diagnostics.restore()
            val clean = diagnostics.receipt().getJSONObject("snapshot")
            assertFalse(clean.getBoolean("truncated"))
            assertEquals(JSONObject.NULL, clean.get("latestSequence"))
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun exactEventFieldsAppendAndPlusOneConsumesNoSequence() {
        val root = Files.createTempDirectory("journal-diagnostics-").toFile()
        try {
            val result = diagnostics(root)
                .exerciseFieldBoundaries()
            assertTrue(result.getBoolean("exactNameAccepted"))
            assertTrue(result.getBoolean("namePlusOneRejected"))
            assertTrue(result.getBoolean("exactDetailsAccepted"))
            assertTrue(result.getBoolean("detailsPlusOneRejected"))
            assertEquals(2, result.getInt("acceptedSequenceCount"))
            assertEquals("2", result.getString("afterLatestSequence"))
            val liveDetails = diagnostics(root).receipt()
                .getJSONObject("snapshot").getJSONArray("events")
                .getJSONObject(0).getJSONObject("details")
            assertEquals("4321", liveDetails.getString("processId"))
            assertEquals(
                "live-diagnostic",
                liveDetails.getString("identitySource"),
            )
        } finally {
            root.deleteRecursively()
        }
    }
}
