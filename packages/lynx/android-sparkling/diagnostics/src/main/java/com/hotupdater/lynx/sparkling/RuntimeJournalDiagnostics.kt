package com.hotupdater.lynx.sparkling

import android.os.Process
import com.hotupdater.lynx.LynxGenerationEventJournal
import java.io.File
import java.security.MessageDigest
import org.json.JSONObject

class RuntimeJournalDiagnostics(
    private val filesDir: File,
    private val processIdentity: () -> String = ::diagnosticRuntimeProcessId,
) {
    private val directory = File(filesDir, "hot-updater-lynx/runtime-events")
    private val file = File(directory, "events.json")
    private var journal = LynxGenerationEventJournal(filesDir)
    private var backup: ByteArray? = null

    fun install(mode: String) {
        if (backup == null) {
            backup = if (file.exists()) file.readBytes() else EMPTY_JOURNAL.toByteArray()
        }
        val bytes = when (mode) {
            "retention-limit" -> retentionEnvelope("retention")
            "count-plus-one" -> countPlusOneEnvelope()
            "byte-plus-one" -> bytePlusOneEnvelope()
            "corrupt-json" -> "{".toByteArray()
            "noncanonical" -> (
                "{ \"schemaVersion\": 1, \"events\": [], " +
                    "\"nextSequence\": \"1\", \"truncated\": false }"
            ).toByteArray()
            "already-oversized" -> byteBoundaryEnvelope(includeAppend = true)
            else -> error("Unknown runtime journal fixture mode")
        }
        write(bytes)
        journal = LynxGenerationEventJournal(filesDir)
    }

    fun append() {
        journal.append(
            "diagnosticFixtureEvent",
            syntheticIdentity(mapOf("fixture" to "append")),
        )
    }

    fun reopen() {
        journal = LynxGenerationEventJournal(filesDir)
        journal.snapshot()
    }

    fun receipt(): JSONObject {
        val snapshot = journal.snapshot()
        val bytes = file.readBytes()
        val sha256 = MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }
        return JSONObject()
            .put("snapshot", snapshot)
            .put("processId", liveProcessId())
            .put("byteLength", bytes.size)
            .put("sha256", sha256)
            .put(
                "canonicalUtf8",
                if (bytes.size <= SMALL_FIXTURE_BYTES) {
                    bytes.toString(Charsets.UTF_8)
                } else {
                    JSONObject.NULL
                },
            )
    }

    fun restore() {
        write(backup ?: EMPTY_JOURNAL.toByteArray())
        backup = null
        journal = LynxGenerationEventJournal(filesDir)
    }

    fun exerciseFieldBoundaries(): JSONObject {
        val before = journal.snapshot().nullableString("latestSequence")
        journal.append("n".repeat(128), liveIdentity())
        val namePlusOneRejected = runCatching {
            journal.append("n".repeat(129), liveIdentity())
        }.isFailure
        val exactPayload = "x".repeat(
            LynxGenerationEventJournal.MAX_EVENT_DETAILS_BYTES -
                liveDetailsWithPayload("").toByteArray().size,
        )
        journal.append(
            "exactDetails",
            liveIdentity(mapOf("payload" to exactPayload)),
        )
        val detailsPlusOneRejected = runCatching {
            journal.append(
                "oversizeDetails",
                liveIdentity(mapOf("payload" to exactPayload + "x")),
            )
        }.isFailure
        val after = journal.snapshot().nullableString("latestSequence")
        return JSONObject()
            .put("exactNameAccepted", true)
            .put("namePlusOneRejected", namePlusOneRejected)
            .put("exactDetailsAccepted", true)
            .put("detailsPlusOneRejected", detailsPlusOneRejected)
            .put("beforeLatestSequence", before ?: JSONObject.NULL)
            .put("afterLatestSequence", after ?: JSONObject.NULL)
            .put("acceptedSequenceCount", 2)
    }

    private fun retentionEnvelope(fixture: String): ByteArray {
        val events = (1..LynxGenerationEventJournal.CAPACITY).map { sequence ->
            event(
                sequence,
                "retentionFixture",
                detailsWithFixture(fixture),
            )
        }
        return envelope(events, 257, false).toByteArray()
    }

    private fun countPlusOneEnvelope(): ByteArray {
        val events = (2..LynxGenerationEventJournal.CAPACITY + 1).map {
            sequence ->
            event(sequence, "retentionFixture", detailsWithFixture("count"))
        }
        return envelope(
            events,
            LynxGenerationEventJournal.CAPACITY + 2,
            true,
        ).toByteArray()
    }

    private fun bytePlusOneEnvelope(): ByteArray {
        val payloadBytes = MutableList(LynxGenerationEventJournal.CAPACITY) {
            MAX_PAYLOAD_BYTES
        }
        fun candidate(): ByteArray = envelope(
            payloadBytes.mapIndexed { index, count ->
                event(
                    index + 1,
                    "byteFixture",
                    detailsWithPayload("x".repeat(count)),
                )
            },
            LynxGenerationEventJournal.CAPACITY + 1,
            false,
        ).toByteArray()

        var excess = candidate().size -
            (LynxGenerationEventJournal.MAX_JOURNAL_BYTES + 1)
        check(excess >= 0) { "Could not construct the journal byte boundary" }
        for (index in payloadBytes.indices.reversed()) {
            if (excess == 0) break
            val reduction = minOf(payloadBytes[index], excess)
            payloadBytes[index] -= reduction
            excess -= reduction
        }
        check(excess == 0) { "Could not construct the journal byte boundary" }
        check(
            candidate().size == LynxGenerationEventJournal.MAX_JOURNAL_BYTES + 1,
        ) { "Could not construct the journal byte boundary" }

        val retained = payloadBytes.drop(1).mapIndexed { index, count ->
            event(
                index + 2,
                "byteFixture",
                detailsWithPayload("x".repeat(count)),
            )
        }
        return envelope(
            retained,
            LynxGenerationEventJournal.CAPACITY + 1,
            true,
        ).toByteArray().also { bytes ->
            check(bytes.size <= LynxGenerationEventJournal.MAX_JOURNAL_BYTES)
        }
    }

    private fun byteBoundaryEnvelope(includeAppend: Boolean): ByteArray {
        val emptyPayloadEvents = (1..LynxGenerationEventJournal.CAPACITY).map {
            sequence -> event(sequence, "byteFixture", detailsWithPayload(""))
        }.toMutableList()
        val appendEvent = event(
            LynxGenerationEventJournal.CAPACITY + 1,
            "diagnosticFixtureEvent",
            detailsWithFixture("append"),
        )
        val candidate = envelope(
            emptyPayloadEvents + appendEvent,
            LynxGenerationEventJournal.CAPACITY + 2,
            false,
        )
        var remaining = LynxGenerationEventJournal.MAX_JOURNAL_BYTES + 1 -
            candidate.toByteArray().size
        check(remaining > 0)
        for (index in emptyPayloadEvents.indices) {
            val payloadBytes = minOf(remaining, MAX_PAYLOAD_BYTES)
            emptyPayloadEvents[index] = event(
                index + 1,
                "byteFixture",
                detailsWithPayload("x".repeat(payloadBytes)),
            )
            remaining -= payloadBytes
        }
        check(remaining == 0) { "Could not construct the journal byte boundary" }
        val result = envelope(
            if (includeAppend) emptyPayloadEvents + appendEvent else emptyPayloadEvents,
            if (includeAppend) {
                LynxGenerationEventJournal.CAPACITY + 2
            } else {
                LynxGenerationEventJournal.CAPACITY + 1
            },
            false,
        ).toByteArray()
        if (includeAppend) {
            check(result.size == LynxGenerationEventJournal.MAX_JOURNAL_BYTES + 1)
        } else {
            check(result.size < LynxGenerationEventJournal.MAX_JOURNAL_BYTES)
        }
        return result
    }

    private fun event(sequence: Int, name: String, details: String) =
        "{\"details\":$details,\"name\":\"$name\",\"sequence\":\"$sequence\"}"

    private fun syntheticIdentity(extra: Map<String, Any?> = emptyMap()) =
        linkedMapOf<String, Any?>(
            "runtimeId" to "diagnostic-runtime",
            "processId" to "1",
            "generationId" to "diagnostic-generation",
            "identitySource" to "synthetic-fixture",
            "bundleId" to "diagnostic-bundle",
            "releaseId" to null,
            "contextId" to null,
            "pageAttemptId" to null,
            "transitionId" to null,
        ) + extra

    private fun liveIdentity(extra: Map<String, Any?> = emptyMap()) =
        syntheticIdentity(extra) + mapOf(
            "processId" to liveProcessId(),
            "identitySource" to "live-diagnostic",
        )

    private fun detailsWithFixture(fixture: String) =
        "{\"bundleId\":\"diagnostic-bundle\",\"contextId\":null," +
            "\"fixture\":\"$fixture\",\"generationId\":\"diagnostic-generation\"," +
            "\"identitySource\":\"synthetic-fixture\",\"pageAttemptId\":null," +
            "\"processId\":\"1\",\"releaseId\":null," +
            "\"runtimeId\":\"diagnostic-runtime\",\"transitionId\":null}"

    private fun liveProcessId(): String = processIdentity().also { processId ->
        check(processId.matches(Regex("^[1-9][0-9]*$"))) {
            "The diagnostics process identity is invalid"
        }
    }

    private fun detailsWithPayload(payload: String) =
        PAYLOAD_DETAILS_PREFIX + payload + PAYLOAD_DETAILS_SUFFIX

    private fun liveDetailsWithPayload(payload: String) =
        "{\"bundleId\":\"diagnostic-bundle\",\"contextId\":null," +
            "\"generationId\":\"diagnostic-generation\"," +
            "\"identitySource\":\"live-diagnostic\"," +
            "\"pageAttemptId\":null,\"payload\":\"$payload\"," +
            "\"processId\":\"${liveProcessId()}\",\"releaseId\":null," +
            "\"runtimeId\":\"diagnostic-runtime\",\"transitionId\":null}"

    private fun envelope(
        events: List<String>,
        nextSequence: Int,
        truncated: Boolean,
    ) = "{\"events\":[${events.joinToString(",")}]," +
        "\"nextSequence\":\"$nextSequence\",\"schemaVersion\":1," +
        "\"truncated\":$truncated}"

    private fun write(bytes: ByteArray) {
        directory.mkdirs()
        file.writeBytes(bytes)
    }

    private fun JSONObject.nullableString(key: String): String? =
        opt(key)?.takeUnless { it == JSONObject.NULL } as? String

    companion object {
        private const val SMALL_FIXTURE_BYTES = 1024 * 1024
        private const val PAYLOAD_DETAILS_PREFIX =
            "{\"bundleId\":\"diagnostic-bundle\",\"contextId\":null," +
                "\"generationId\":\"diagnostic-generation\"," +
                "\"identitySource\":\"synthetic-fixture\"," +
                "\"pageAttemptId\":null,\"payload\":\""
        private const val PAYLOAD_DETAILS_SUFFIX =
            "\",\"processId\":\"1\",\"releaseId\":null," +
                "\"runtimeId\":\"diagnostic-runtime\",\"transitionId\":null}"
        private val MAX_PAYLOAD_BYTES =
            LynxGenerationEventJournal.MAX_EVENT_DETAILS_BYTES -
                (PAYLOAD_DETAILS_PREFIX + PAYLOAD_DETAILS_SUFFIX)
                    .toByteArray().size
        private const val EMPTY_JOURNAL =
            "{\"events\":[],\"nextSequence\":\"1\",\"schemaVersion\":1," +
                "\"truncated\":false}"
    }
}

private fun diagnosticRuntimeProcessId(): String {
    val processId = Process.myPid()
    check(processId > 0) { "The diagnostics process identity is invalid" }
    return processId.toString()
}
