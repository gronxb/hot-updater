package com.hotupdater.lynx

import android.content.Context
import android.util.Log
import com.hotupdater.lynx.internal.DurableFiles
import com.hotupdater.lynx.internal.ManagedPaths
import java.io.File
import java.io.FileOutputStream
import java.math.BigInteger
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.erdtman.jcs.NumberToJSON

/** Bounded native evidence from actual managed host and engine callbacks. */
class LynxGenerationEventJournal internal constructor(
    filesDir: File,
    private val limits: Limits,
    private val postCommitDirectorySync: (File) -> Unit =
        DurableFiles::syncDirectory,
) {
    constructor(filesDir: File) : this(filesDir, Limits())
    constructor(context: Context) : this(context.filesDir)

    private val directory = File(filesDir, "hot-updater-lynx/runtime-events").canonicalFile
    private val journalFile = File(directory, "events.json")

    fun append(name: String, details: Map<String, Any?>) = synchronized(LOCK) {
        validateName(name)
        val jsonDetails = JSONObject().also { output ->
            details.forEach { (key, value) -> output.put(key, normalize(value)) }
        }
        validateDetails(name, jsonDetails)
        val canonicalDetails = canonical(jsonDetails)
        require(canonicalDetails.toByteArray(Charsets.UTF_8).size <= limits.detailBytes) {
            "Runtime event details exceed the byte limit"
        }
        append(readState(), name, jsonDetails)
    }

    fun appendOnce(
        name: String,
        identityKey: String,
        identityValue: String,
        details: Map<String, Any?>,
    ): Boolean = synchronized(LOCK) {
        validateName(name)
        require(identityKey.isNotEmpty() && identityValue.isNotEmpty()) {
            "A runtime event identity is required"
        }
        val jsonDetails = JSONObject().also { output ->
            details.forEach { (key, value) -> output.put(key, normalize(value)) }
        }
        validateDetails(name, jsonDetails)
        val canonicalDetails = canonical(jsonDetails)
        require(canonicalDetails.toByteArray(Charsets.UTF_8).size <= limits.detailBytes) {
            "Runtime event details exceed the byte limit"
        }
        val current = readState()
        val existing = current.getJSONArray("events")
        if ((0 until existing.length()).any { index ->
                existing.getJSONObject(index).getString("name") == name &&
                    existing.getJSONObject(index).getJSONObject("details")
                        .optString(identityKey) == identityValue
            }
        ) return@synchronized false
        append(current, name, jsonDetails)
        true
    }

    private fun append(current: JSONObject, name: String, details: JSONObject) {
        val sequence = BigInteger(current.getString("nextSequence"))
        val retained = mutableListOf<JSONObject>()
        val existing = current.getJSONArray("events")
        for (index in 0 until existing.length()) {
            retained += JSONObject(existing.getJSONObject(index).toString())
        }
        retained += JSONObject()
            .put("sequence", sequence.toString())
            .put("name", name)
            .put("details", details)
        var truncated = current.getBoolean("truncated")
        var next = state(sequence + BigInteger.ONE, truncated, retained)
        while (
            retained.size > limits.capacity ||
            canonicalBytes(next).size > limits.journalBytes
        ) {
            check(retained.isNotEmpty()) { "Runtime event cannot fit the journal" }
            retained.removeAt(0)
            truncated = true
            next = state(sequence + BigInteger.ONE, truncated, retained)
        }
        writeState(next)
    }

    fun snapshot(): JSONObject = synchronized(LOCK) {
        val state = readState()
        val stored = state.getJSONArray("events")
        val oldest = stored.optJSONObject(0)?.getString("sequence")
        val latest = stored.optJSONObject(stored.length() - 1)?.getString("sequence")
        JSONObject()
            .put("schemaVersion", SCHEMA_VERSION)
            .put("latestSequence", latest ?: JSONObject.NULL)
            .put("oldestSequence", oldest ?: JSONObject.NULL)
            .put("truncated", state.getBoolean("truncated"))
            .put("events", JSONArray(stored.toString()))
    }

    private fun readState(): JSONObject {
        if (!journalFile.exists()) {
            val initial = emptyState(false)
            writeState(initial)
            return initial
        }
        check(journalFile.isFile) { "Runtime event journal path is not a file" }
        val bytes = if (journalFile.length() <= limits.journalBytes) {
            runCatching { journalFile.readBytes() }.getOrNull()
        } else null
        val restored = bytes?.let { persisted ->
            runCatching {
                val state = JSONObject(persisted.toString(Charsets.UTF_8))
                validateState(state)
                check(canonicalBytes(state).contentEquals(persisted))
                state
            }.getOrNull()
        }
        if (restored != null) return restored
        return emptyState(true).also(::writeState)
    }

    private fun validateState(state: JSONObject) {
        check(state.keys().asSequence().toSet() == ENVELOPE_KEYS)
        check(state.get("schemaVersion") is Number && state.getInt("schemaVersion") == 1)
        check(state.get("truncated") is Boolean)
        val nextText = state.get("nextSequence") as? String ?: error("Invalid next sequence")
        check(SEQUENCE.matches(nextText))
        val next = BigInteger(nextText)
        val events = state.get("events") as? JSONArray ?: error("Invalid events")
        check(events.length() <= limits.capacity)
        var expected: BigInteger? = null
        for (index in 0 until events.length()) {
            val event = events.getJSONObject(index)
            check(event.keys().asSequence().toSet() == EVENT_KEYS)
            val sequenceText = event.get("sequence") as? String ?: error("Invalid sequence")
            check(SEQUENCE.matches(sequenceText))
            val sequence = BigInteger(sequenceText)
            expected?.let { check(sequence == it) }
            expected = sequence + BigInteger.ONE
            val name = event.get("name") as? String ?: error("Invalid event name")
            validateName(name)
            val details = event.get("details") as? JSONObject ?: error("Invalid details")
            validateDetails(name, details)
            check(canonical(details).toByteArray(Charsets.UTF_8).size <= limits.detailBytes)
        }
        if (events.length() == 0) {
            check(next == BigInteger.ONE)
        } else {
            check(expected == next)
            if (!state.getBoolean("truncated")) {
                check(events.getJSONObject(0).getString("sequence") == "1")
            }
        }
    }

    private fun validateName(name: String) {
        require(name.isNotEmpty()) { "A runtime event name is required" }
        require(name.toByteArray(Charsets.UTF_8).size <= limits.nameBytes) {
            "Runtime event name exceeds the byte limit"
        }
        canonicalString(name)
    }

    private fun validateRuntimeIdentity(details: JSONObject) {
        check(details.keys().asSequence().toSet().containsAll(IDENTITY_KEYS)) {
            "Runtime event identity is incomplete"
        }
        listOf("runtimeId", "generationId", "bundleId").forEach { key ->
            check((details.opt(key) as? String)?.isNotEmpty() == true) {
                "Runtime event $key is invalid"
            }
        }
        check(
            (details.opt("processId") as? String)?.matches(SEQUENCE) == true,
        ) { "Runtime event processId is invalid" }
        listOf("releaseId", "contextId", "pageAttemptId", "transitionId")
            .forEach { key ->
                val value = details.get(key)
                check(value == JSONObject.NULL ||
                    (value as? String)?.isNotEmpty() == true) {
                    "Runtime event $key is invalid"
                }
            }
    }

    private fun validateDetails(name: String, details: JSONObject) {
        validateRuntimeIdentity(details)
        if (name != ENGINE_DIAGNOSTIC_EVENT) return
        check((details.opt("contextId") as? String)?.isNotEmpty() == true) {
            "Engine diagnostic contextId is invalid"
        }
        check((details.opt("attemptId") as? String)?.isNotEmpty() == true) {
            "Engine diagnostic attemptId is invalid"
        }
        check(details.opt("fatal") is Boolean) {
            "Engine diagnostic fatal is invalid"
        }
        check(details.opt("code") is Int) {
            "Engine diagnostic code is invalid"
        }
        check(details.opt("subcode") is Int) {
            "Engine diagnostic subcode is invalid"
        }
        check((details.opt("type") as? String)?.isNotEmpty() == true) {
            "Engine diagnostic type is invalid"
        }
        val path = details.opt("path") as? String
            ?: error("Engine diagnostic path is invalid")
        check(
            ManagedPaths.normalize(path) == path &&
                path.none { it == '%' || it == '?' || it == '#' },
        ) {
            "Engine diagnostic path is not canonical"
        }
    }

    private fun state(
        nextSequence: BigInteger,
        truncated: Boolean,
        events: List<JSONObject>,
    ) = JSONObject()
        .put("events", JSONArray(events))
        .put("nextSequence", nextSequence.toString())
        .put("schemaVersion", SCHEMA_VERSION)
        .put("truncated", truncated)

    private fun emptyState(truncated: Boolean) =
        state(BigInteger.ONE, truncated, emptyList())

    private fun writeState(state: JSONObject) {
        val bytes = canonicalBytes(state)
        check(bytes.size <= limits.journalBytes)
        DurableFiles.directory(directory)
        val staging = File(directory, "events.next-${UUID.randomUUID()}")
        try {
            FileOutputStream(staging).use { output ->
                output.write(bytes)
                output.fd.sync()
            }
            DurableFiles.replace(staging, journalFile)
            runCatching { postCommitDirectorySync(directory) }
                .onFailure { error ->
                    runCatching {
                        Log.e(
                            TAG,
                            "Runtime event journal directory sync failed after commit",
                            error,
                        )
                    }
                }
        } finally {
            if (staging.exists()) check(staging.delete())
        }
    }

    private fun canonicalBytes(value: Any) = canonical(value).toByteArray(Charsets.UTF_8)

    private fun normalize(value: Any?): Any = when (value) {
        null, JSONObject.NULL -> JSONObject.NULL
        is String, is Boolean, is Byte, is Short, is Int, is Long,
        is Float, is Double -> value
        is JSONObject, is JSONArray -> value
        is Map<*, *> -> JSONObject().also { output ->
            value.forEach { (key, item) ->
                require(key is String) { "Runtime event object keys must be strings" }
                output.put(key, normalize(item))
            }
        }
        is Iterable<*> -> JSONArray().also { output ->
            value.forEach { output.put(normalize(it)) }
        }
        is Array<*> -> JSONArray().also { output ->
            value.forEach { output.put(normalize(it)) }
        }
        else -> if (value.javaClass.isArray) {
            JSONArray().also { output ->
                repeat(java.lang.reflect.Array.getLength(value)) { index ->
                    output.put(normalize(java.lang.reflect.Array.get(value, index)))
                }
            }
        } else {
            throw IllegalArgumentException("Unsupported runtime event JSON value")
        }
    }

    private fun canonical(value: Any?): String = when (value) {
        null, JSONObject.NULL -> "null"
        is String -> canonicalString(value)
        is Boolean -> value.toString()
        is Number -> canonicalNumber(value.toDouble())
        is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") {
            canonical(value.get(it))
        }
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") {
            canonicalString(it) + ":" + canonical(value.get(it))
        }
        else -> throw IllegalArgumentException("Unsupported runtime event JSON value")
    }

    private fun canonicalNumber(value: Double): String {
        require(value.isFinite()) { "Runtime event numbers must be finite" }
        return runCatching { NumberToJSON.serializeNumber(value) }
            .getOrElse {
                throw IllegalArgumentException(
                    "Runtime event number cannot be canonicalized",
                    it,
                )
            }
    }

    private fun canonicalString(value: String): String {
        val output = StringBuilder(value.length + 2).append('"')
        var index = 0
        while (index < value.length) {
            val character = value[index]
            when (character) {
                '"' -> output.append("\\\"")
                '\\' -> output.append("\\\\")
                '\b' -> output.append("\\b")
                '\t' -> output.append("\\t")
                '\n' -> output.append("\\n")
                '\u000c' -> output.append("\\f")
                '\r' -> output.append("\\r")
                else -> when {
                    character.code < 0x20 -> output.append("\\u")
                        .append(character.code.toString(16).padStart(4, '0'))
                    character.isHighSurrogate() -> {
                        require(index + 1 < value.length && value[index + 1].isLowSurrogate()) {
                            "Runtime event strings must contain valid Unicode"
                        }
                        output.append(character).append(value[index + 1])
                        index += 1
                    }
                    character.isLowSurrogate() -> throw IllegalArgumentException(
                        "Runtime event strings must contain valid Unicode",
                    )
                    else -> output.append(character)
                }
            }
            index += 1
        }
        return output.append('"').toString()
    }

    companion object {
        const val CAPACITY = 256
        const val MAX_EVENT_NAME_BYTES = 128
        const val MAX_EVENT_DETAILS_BYTES = 64 * 1024
        const val MAX_JOURNAL_BYTES = 16 * 1024 * 1024
        private const val SCHEMA_VERSION = 1
        private const val ENGINE_DIAGNOSTIC_EVENT = "engineDiagnostic"
        private const val TAG = "HotUpdaterLynxEvents"
        private val SEQUENCE = Regex("^[1-9][0-9]*$")
        private val ENVELOPE_KEYS = setOf("events", "nextSequence", "schemaVersion", "truncated")
        private val EVENT_KEYS = setOf("sequence", "name", "details")
        private val IDENTITY_KEYS = setOf(
            "runtimeId",
            "processId",
            "generationId",
            "bundleId",
            "releaseId",
            "contextId",
            "pageAttemptId",
            "transitionId",
        )
        private val LOCK = Any()
    }

    internal data class Limits(
        val capacity: Int = CAPACITY,
        val nameBytes: Int = MAX_EVENT_NAME_BYTES,
        val detailBytes: Int = MAX_EVENT_DETAILS_BYTES,
        val journalBytes: Int = MAX_JOURNAL_BYTES,
    )
}
