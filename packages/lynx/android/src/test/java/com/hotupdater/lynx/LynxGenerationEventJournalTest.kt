package com.hotupdater.lynx

import java.nio.file.Files
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class LynxGenerationEventJournalTest {
    private fun identity(extra: Map<String, Any?> = emptyMap()) =
        linkedMapOf<String, Any?>(
            "runtimeId" to "runtime-a",
            "processId" to "1234",
            "generationId" to "generation-a",
            "bundleId" to "bundle-a",
            "releaseId" to null,
            "contextId" to "context-a",
            "pageAttemptId" to null,
            "transitionId" to null,
        ) + extra

    @Test
    fun persistsAuthenticDetailsWithStringSequences() {
        val root = Files.createTempDirectory("lynx-events-").toFile()
        try {
            val first = LynxGenerationEventJournal(root)
            first.append(
                "routeOpened",
                identity(mapOf(
                    "generationId" to "generation-a",
                    "contextId" to "context-detail",
                    "orderedPageEntries" to listOf(
                        "main.lynx.bundle",
                        "detail.lynx.bundle",
                    ),
                    "orderedPageParameters" to listOf(
                        emptyMap<String, String>(),
                        mapOf("title" to "Second Page"),
                    ),
                )),
            )
            first.append(
                "pageAdmitted",
                identity(mapOf("pageAttemptId" to "attempt-detail")),
            )

            val restored = LynxGenerationEventJournal(root).snapshot()

            assertEquals(
                setOf(
                    "schemaVersion",
                    "latestSequence",
                    "oldestSequence",
                    "truncated",
                    "events",
                ),
                restored.keySet(),
            )
            assertEquals(1, restored.getInt("schemaVersion"))
            assertEquals("1", restored.getString("oldestSequence"))
            assertEquals("2", restored.getString("latestSequence"))
            assertFalse(restored.getBoolean("truncated"))
            val events = restored.getJSONArray("events")
            assertEquals(2, events.length())
            val event = events.getJSONObject(1)
            assertEquals(
                setOf("sequence", "name", "details"),
                event.keySet(),
            )
            assertEquals("2", event.getString("sequence"))
            assertEquals("pageAdmitted", event.getString("name"))
            assertEquals(
                "attempt-detail",
                event.getJSONObject("details").getString("pageAttemptId"),
            )
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun canonicalizesRecursiveDetailsWithRfc8785NumberAndStringForms() {
        val root = Files.createTempDirectory("lynx-events-").toFile()
        try {
            LynxGenerationEventJournal(root).append(
                "canonical",
                identity(mapOf(
                    "numbers" to listOf(
                        333333333.33333329,
                        1e30,
                        4.50,
                        2e-3,
                        1e-27,
                    ),
                    "text" to "line\n\u20ac",
                )),
            )
            val persisted = root.resolve(
                "hot-updater-lynx/runtime-events/events.json",
            ).readText()
            assertTrue(
                persisted.contains(
                    "\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27]",
                ),
            )
            assertTrue(persisted.contains("\"text\":\"line\\n€\""))
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun reopensAndAppendsAfterTheRfc8785EdgeNumberVector() {
        val root = Files.createTempDirectory("lynx-events-").toFile()
        try {
            LynxGenerationEventJournal(root).append(
                "numbers",
                identity(linkedMapOf(
                    "a" to 0.0,
                    "b" to -0.0,
                    "c" to Double.MIN_VALUE,
                    "d" to -Double.MIN_VALUE,
                    "e" to Double.MAX_VALUE,
                    "f" to -Double.MAX_VALUE,
                    "g" to java.lang.Double.longBitsToDouble(0x4340000000000000L),
                    "h" to java.lang.Double.longBitsToDouble(0x4430000000000000L),
                    "i" to java.lang.Double.longBitsToDouble(0x44b52d02c7e14af5L),
                    "j" to java.lang.Double.longBitsToDouble(0x44b52d02c7e14af6L),
                    "k" to java.lang.Double.longBitsToDouble(0x44b52d02c7e14af7L),
                    "l" to java.lang.Double.longBitsToDouble(0x444b1ae4d6e2ef4eL),
                    "m" to java.lang.Double.longBitsToDouble(0x444b1ae4d6e2ef4fL),
                    "n" to java.lang.Double.longBitsToDouble(0x444b1ae4d6e2ef50L),
                )),
            )
            val file = root.resolve("hot-updater-lynx/runtime-events/events.json")
            val persisted = file.readText()
            listOf(
                "\"a\":0",
                "\"b\":0",
                "\"c\":5e-324",
                "\"d\":-5e-324",
                "\"e\":1.7976931348623157e+308",
                "\"f\":-1.7976931348623157e+308",
                "\"g\":9007199254740992",
                "\"h\":295147905179352830000",
                "\"i\":9.999999999999997e+22",
                "\"j\":1e+23",
                "\"k\":1.0000000000000001e+23",
                "\"l\":999999999999999700000",
                "\"m\":999999999999999900000",
                "\"n\":1e+21",
            ).forEach { number -> assertTrue(number, persisted.contains(number)) }

            val reopened = LynxGenerationEventJournal(root)
            assertEquals("1", reopened.snapshot().getString("latestSequence"))
            reopened.append(
                "afterReopen",
                identity(mapOf("minimum" to Double.MIN_VALUE)),
            )
            val restored = LynxGenerationEventJournal(root).snapshot()
            assertEquals("1", restored.getString("oldestSequence"))
            assertEquals("2", restored.getString("latestSequence"))
            assertFalse(restored.getBoolean("truncated"))
            assertEquals(2, restored.getJSONArray("events").length())
            assertEquals(
                Double.MIN_VALUE,
                restored.getJSONArray("events").getJSONObject(1)
                    .getJSONObject("details").getDouble("minimum"),
                0.0,
            )
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun invalidRecursiveJsonConsumesNoSequenceOrDurableMutation() {
        val root = Files.createTempDirectory("lynx-events-").toFile()
        try {
            val journal = LynxGenerationEventJournal(root)
            journal.append("before", identity())
            assertThrows(IllegalArgumentException::class.java) {
                journal.append("invalid", identity(mapOf("file" to root)))
            }
            journal.append("after", identity())
            val snapshot = journal.snapshot()
            assertEquals("2", snapshot.getString("latestSequence"))
            assertEquals(2, snapshot.getJSONArray("events").length())
            assertEquals(
                "after",
                snapshot.getJSONArray("events").getJSONObject(1).getString("name"),
            )
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun emptySnapshotUsesNullBoundsWithoutInventingEvents() {
        val root = Files.createTempDirectory("lynx-events-").toFile()
        try {
            val snapshot = LynxGenerationEventJournal(root).snapshot()

            assertEquals(JSONObject.NULL, snapshot.get("oldestSequence"))
            assertEquals(JSONObject.NULL, snapshot.get("latestSequence"))
            assertFalse(snapshot.getBoolean("truncated"))
            assertEquals(0, snapshot.getJSONArray("events").length())
            assertEquals(
                "{\"events\":[],\"nextSequence\":\"1\"," +
                    "\"schemaVersion\":1,\"truncated\":false}",
                root.resolve("hot-updater-lynx/runtime-events/events.json")
                    .readText(),
            )
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun wrongTypeStorageIsUnavailableUntilItIsActuallyRepaired() {
        val blockedParentRoot = Files.createTempDirectory("lynx-events-").toFile()
        val directoryJournalRoot = Files.createTempDirectory("lynx-events-").toFile()
        try {
            val blockedParent = blockedParentRoot.resolve(
                "hot-updater-lynx/runtime-events",
            )
            blockedParent.parentFile.mkdirs()
            blockedParent.writeText("not-a-directory")
            assertThrows(IllegalStateException::class.java) {
                LynxGenerationEventJournal(blockedParentRoot).snapshot()
            }
            assertTrue(blockedParent.delete())
            val repairedParent = LynxGenerationEventJournal(blockedParentRoot)
            assertFalse(repairedParent.snapshot().getBoolean("truncated"))
            repairedParent.append("afterRepair", identity())
            assertEquals(
                "1",
                repairedParent.snapshot().getString("latestSequence"),
            )

            val journalPath = directoryJournalRoot.resolve(
                "hot-updater-lynx/runtime-events/events.json",
            )
            assertTrue(journalPath.mkdirs())
            assertThrows(IllegalStateException::class.java) {
                LynxGenerationEventJournal(directoryJournalRoot).snapshot()
            }
            assertTrue(journalPath.delete())
            val repairedFile = LynxGenerationEventJournal(directoryJournalRoot)
            assertFalse(repairedFile.snapshot().getBoolean("truncated"))
            repairedFile.append("afterRepair", identity())
            assertEquals(
                "1",
                repairedFile.snapshot().getString("latestSequence"),
            )
        } finally {
            blockedParentRoot.deleteRecursively()
            directoryJournalRoot.deleteRecursively()
        }
    }

    @Test
    fun replaysOneTerminalPerPageAttemptAndKeepsExplicitNullIdentity() {
        val root = Files.createTempDirectory("lynx-events-").toFile()
        try {
            val journal = LynxGenerationEventJournal(root)
            val details = identity(mapOf(
                "pageAttemptId" to "attempt-detail",
                "terminal" to "process-interruption",
                "topContextId" to null,
            ))

            assertTrue(
                journal.appendOnce(
                    "pageAttemptTerminal",
                    "pageAttemptId",
                    "attempt-detail",
                    details,
                ),
            )
            assertFalse(
                LynxGenerationEventJournal(root).appendOnce(
                    "pageAttemptTerminal",
                    "pageAttemptId",
                    "attempt-detail",
                    details,
                ),
            )

            val events = journal.snapshot().getJSONArray("events")
            assertEquals(1, events.length())
            val terminal = events.getJSONObject(0).getJSONObject("details")
            assertEquals(JSONObject.NULL, terminal.get("topContextId"))
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun appendOnceValidatesBeforeInitializationOrDuplicateLookup() {
        val root = Files.createTempDirectory("lynx-events-").toFile()
        try {
            val journal = LynxGenerationEventJournal(root)
            val invalid = identity(
                mapOf("pageAttemptId" to "attempt-a", "file" to root),
            )
            assertThrows(IllegalArgumentException::class.java) {
                journal.appendOnce(
                    "pageAttemptTerminal",
                    "pageAttemptId",
                    "attempt-a",
                    invalid,
                )
            }
            val file = root.resolve(
                "hot-updater-lynx/runtime-events/events.json",
            )
            assertFalse(file.exists())

            val valid = identity(mapOf("pageAttemptId" to "attempt-a"))
            assertTrue(journal.appendOnce(
                "pageAttemptTerminal",
                "pageAttemptId",
                "attempt-a",
                valid,
            ))
            assertThrows(IllegalArgumentException::class.java) {
                journal.appendOnce(
                    "pageAttemptTerminal",
                    "pageAttemptId",
                    "attempt-a",
                    invalid,
                )
            }
            val snapshot = journal.snapshot()
            assertEquals("1", snapshot.getString("latestSequence"))
            assertEquals(1, snapshot.getJSONArray("events").length())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun boundsTheDurableJournalAndReportsACursorGap() {
        val root = Files.createTempDirectory("lynx-events-").toFile()
        try {
            val journal = LynxGenerationEventJournal(root)
            repeat(LynxGenerationEventJournal.CAPACITY + 2) { index ->
                journal.append("event", identity(mapOf("index" to index)))
            }

            val snapshot = journal.snapshot()

            assertEquals("3", snapshot.getString("oldestSequence"))
            assertEquals("258", snapshot.getString("latestSequence"))
            assertTrue(snapshot.getBoolean("truncated"))
            assertEquals(
                LynxGenerationEventJournal.CAPACITY,
                snapshot.getJSONArray("events").length(),
            )
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun enforcesExactNameAndDetailByteBounds() {
        val root = Files.createTempDirectory("lynx-events-").toFile()
        try {
            val journal = LynxGenerationEventJournal(root)
            journal.append("n".repeat(128), identity())
            assertThrows(IllegalArgumentException::class.java) {
                journal.append("n".repeat(129), identity())
            }
            val emptyDetailsBytes = (
                "{\"bundleId\":\"bundle-a\",\"contextId\":\"context-a\"," +
                    "\"generationId\":\"generation-a\",\"pageAttemptId\":null," +
                    "\"processId\":\"1234\",\"releaseId\":null," +
                    "\"runtimeId\":\"runtime-a\",\"transitionId\":null,\"v\":\"\"}"
            ).toByteArray().size
            val exactValue = "v".repeat(
                LynxGenerationEventJournal.MAX_EVENT_DETAILS_BYTES -
                    emptyDetailsBytes,
            )
            journal.append("exactDetails", identity(mapOf("v" to exactValue)))
            assertThrows(IllegalArgumentException::class.java) {
                journal.append(
                    "oversizeDetails",
                    identity(mapOf("v" to exactValue + "v")),
                )
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun serializedLimitEvictsBeforeAppendAndKeepsTruncationSticky() {
        val root = Files.createTempDirectory("lynx-events-").toFile()
        try {
            val journal = LynxGenerationEventJournal(
                root,
                LynxGenerationEventJournal.Limits(
                    capacity = 256,
                    journalBytes = 400,
                ),
            )
            journal.append("first", identity(mapOf("value" to "a".repeat(40))))
            journal.append("second", identity(mapOf("value" to "b".repeat(40))))

            val snapshot = journal.snapshot()
            assertTrue(snapshot.getBoolean("truncated"))
            assertEquals("2", snapshot.getString("latestSequence"))
            assertEquals("2", snapshot.getString("oldestSequence"))
            assertEquals(1, snapshot.getJSONArray("events").length())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun corruptAndOversizePersistedJournalsFailClosedAsTruncated() {
        listOf("{" to false, "x" to true).forEach { (contents, oversize) ->
            val root = Files.createTempDirectory("lynx-events-").toFile()
            try {
                val file = root.resolve("hot-updater-lynx/runtime-events/events.json")
                file.parentFile.mkdirs()
                if (oversize) {
                    java.io.RandomAccessFile(file, "rw").use {
                        it.setLength(
                            LynxGenerationEventJournal.MAX_JOURNAL_BYTES.toLong() + 1,
                        )
                    }
                } else {
                    file.writeText(contents)
                }
                val snapshot = LynxGenerationEventJournal(root).snapshot()
                assertTrue(snapshot.getBoolean("truncated"))
                assertEquals(JSONObject.NULL, snapshot.get("latestSequence"))
                assertEquals(0, snapshot.getJSONArray("events").length())
                val repaired = JSONObject(file.readText())
                assertEquals(
                    "{\"events\":[],\"nextSequence\":\"1\"," +
                        "\"schemaVersion\":1,\"truncated\":true}",
                    file.readText(),
                )
                assertEquals(
                    setOf("events", "nextSequence", "schemaVersion", "truncated"),
                    repaired.keySet(),
                )
                assertEquals("1", repaired.getString("nextSequence"))
                assertTrue(repaired.getBoolean("truncated"))
                LynxGenerationEventJournal(root).append("afterRepair", identity())
                val resumed = LynxGenerationEventJournal(root).snapshot()
                assertEquals("1", resumed.getString("latestSequence"))
                assertTrue(resumed.getBoolean("truncated"))
            } finally {
                root.deleteRecursively()
            }
        }
    }

    @Test
    fun persistedIdentityViolationsRepairBeforeAnyEventIsTrusted() {
        val validPrefix =
            "{\"bundleId\":\"bundle-a\",\"contextId\":null," +
                "\"generationId\":\"generation-a\",\"pageAttemptId\":null,"
        val validSuffix =
            ",\"releaseId\":null,\"runtimeId\":\"runtime-a\"," +
                "\"transitionId\":null}"
        val invalidDetails = listOf(
            validPrefix + "\"processId\":1234" + validSuffix,
            validPrefix + "\"processId\":\"0\"" + validSuffix,
            validPrefix + "\"processId\":\"01234\"" + validSuffix,
            validPrefix.removeSuffix(",") + validSuffix,
            validPrefix + "\"processId\":null" + validSuffix,
            validPrefix + "\"processId\":\"1234\",\"releaseId\":null," +
                "\"runtimeId\":\"\",\"transitionId\":null}",
            validPrefix + "\"processId\":\"1234\",\"releaseId\":null," +
                "\"runtimeId\":\"runtime-a\",\"transitionID\":null}",
        )
        invalidDetails.forEach { details ->
            val root = Files.createTempDirectory("lynx-events-").toFile()
            try {
                val file = root.resolve(
                    "hot-updater-lynx/runtime-events/events.json",
                )
                file.parentFile.mkdirs()
                file.writeText(
                    "{\"events\":[{\"details\":$details," +
                        "\"name\":\"event\",\"sequence\":\"1\"}]," +
                        "\"nextSequence\":\"2\",\"schemaVersion\":1," +
                        "\"truncated\":false}",
                )

                val snapshot = LynxGenerationEventJournal(root).snapshot()

                assertTrue(snapshot.getBoolean("truncated"))
                assertEquals(0, snapshot.getJSONArray("events").length())
                assertEquals(
                    "{\"events\":[],\"nextSequence\":\"1\"," +
                        "\"schemaVersion\":1,\"truncated\":true}",
                    file.readText(),
                )
            } finally {
                root.deleteRecursively()
            }
        }
    }

    @Test
    fun persistsTheExactCompactCanonicalEnvelope() {
        val root = Files.createTempDirectory("lynx-events-").toFile()
        try {
            LynxGenerationEventJournal(root).append(
                "event",
                identity(linkedMapOf("z" to 1, "a" to "value")),
            )
            val persisted = root.resolve(
                "hot-updater-lynx/runtime-events/events.json",
            ).readText()
            assertEquals(
                "{\"events\":[{\"details\":{\"a\":\"value\"," +
                    "\"bundleId\":\"bundle-a\",\"contextId\":\"context-a\"," +
                    "\"generationId\":\"generation-a\",\"pageAttemptId\":null," +
                    "\"processId\":\"1234\",\"releaseId\":null," +
                    "\"runtimeId\":\"runtime-a\",\"transitionId\":null,\"z\":1}," +
                    "\"name\":\"event\",\"sequence\":\"1\"}],\"nextSequence\":\"2\"," +
                    "\"schemaVersion\":1,\"truncated\":false}",
                persisted,
            )
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun atomicRenameIsTheCommitPointWhenDirectorySyncFailsAfterward() {
        val root = Files.createTempDirectory("lynx-events-").toFile()
        try {
            val journal = LynxGenerationEventJournal(
                root,
                LynxGenerationEventJournal.Limits(),
            ) { throw java.io.IOException("injected post-commit sync failure") }

            journal.append("committed", identity(mapOf("value" to 1)))
            val reopened = LynxGenerationEventJournal(root)
            assertEquals("1", reopened.snapshot().getString("latestSequence"))
            reopened.append("afterReopen", identity())
            val events = LynxGenerationEventJournal(root).snapshot()
                .getJSONArray("events")
            assertEquals(2, events.length())
            assertEquals("committed", events.getJSONObject(0).getString("name"))
            assertEquals("afterReopen", events.getJSONObject(1).getString("name"))
        } finally {
            root.deleteRecursively()
        }
    }
}
