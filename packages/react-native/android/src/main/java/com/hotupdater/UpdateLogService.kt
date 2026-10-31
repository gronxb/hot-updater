package com.hotupdater

import android.util.Log
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** One update event for [UpdateLogService]. */
class UpdateLogEvent internal constructor(
    val type: String,
    val outcome: String,
    val bundleId: String? = null,
    val fromBundleId: String? = null,
    val releaseId: String? = null,
    val channel: String? = null,
    val error: JSONObject? = null,
) {
    companion object {
        const val CHECK = "CHECK"
        const val DOWNLOAD = "DOWNLOAD"
        const val APPLY = "APPLY"
        const val ROLLBACK = "ROLLBACK"
        const val CRASH_RECOVERY = "CRASH_RECOVERY"

        const val UP_TO_DATE = "UP_TO_DATE"
        const val UPDATE_AVAILABLE = "UPDATE_AVAILABLE"
        const val ROLLBACK_AVAILABLE = "ROLLBACK_AVAILABLE"
        const val FAILED = "FAILED"
        const val STAGED = "STAGED"
        const val APPLIED = "APPLIED"
        const val BUILT_IN_SELECTED = "BUILT_IN_SELECTED"
        const val CHANNEL_RESET = "CHANNEL_RESET"
        const val ROLLED_BACK_AFTER_CRASH = "ROLLED_BACK_AFTER_CRASH"
        const val ROLLED_BACK_UNFINISHED_LAUNCH = "ROLLED_BACK_UNFINISHED_LAUNCH"
        const val ROLLED_BACK_MISSING_BUNDLE = "ROLLED_BACK_MISSING_BUNDLE"
        const val KEPT_AFTER_CRASH = "KEPT_AFTER_CRASH"

        /** The error fields of [error]: its code and message, and its classification when it has one. */
        internal fun errorOf(error: Throwable): JSONObject =
            JSONObject().apply {
                put("message", error.message ?: error.javaClass.name)
                val classified = error as? HotUpdaterException ?: error.cause as? HotUpdaterException
                classified?.let { put("code", it.code) }
                classified?.failure?.toUserInfo()?.let { info ->
                    put("stage", info["stage"])
                    put("reason", info["reason"])
                }
            }
    }
}

/**
 * The update log of one instance, which an in-app diagnostics screen reads: a
 * JSON object per line in a file outside device backups, and on this device
 * only.
 *
 * Appends go to a serial background thread, so no launch or first render waits
 * for the file, and a read or clear sees every append made before it. An
 * error while writing or reading never reaches the update it describes, and a
 * line that cannot be read, such as one a killed process left half written, is
 * skipped. Each line starts with its newline, so that half line never takes
 * the next one with it.
 *
 * It keeps the newest [MAX_ENTRIES] entries of the last [MAX_AGE_MILLIS]: an
 * update takes about four entries, so that is dozens of updates, and a week is
 * longer than a support case usually takes to reach the app. The file is
 * trimmed at its first append in a process and every [TRIM_INTERVAL] appends,
 * so it stays small without being rewritten each time, and reads apply the
 * same limits.
 *
 * Entries hold no request headers or URLs with their queries: a message keeps
 * only the host of a URL ([sanitizeMessage]).
 */
class UpdateLogService internal constructor(
    private val file: File,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    companion object {
        private const val TAG = "UpdateLog"
        const val FILENAME = "update-log.jsonl"
        const val MAX_ENTRIES = 200
        const val MAX_AGE_MILLIS = 7L * 24 * 60 * 60 * 1000
        const val TRIM_INTERVAL = 20
        private const val MAX_FIELD_LENGTH = 128
        private const val MAX_MESSAGE_LENGTH = 512
        private const val MAX_RAW_MESSAGE_LENGTH = 4096

        /** More than the entries the limits keep could ever take: not a log this service wrote. */
        const val MAX_FILE_BYTES = 1024L * 1024

        private val ERROR_FIELDS = listOf("code", "stage", "reason")

        /** Native records everything else itself. */
        private val JAVASCRIPT_TYPES = setOf(UpdateLogEvent.CHECK, UpdateLogEvent.DOWNLOAD)
        private val URL_PATTERN = Regex("""([A-Za-z][A-Za-z0-9+.-]*://)(?:[^\s/?#@]*@)?([^\s/?#]*)\S*""")
        private val services = ConcurrentHashMap<String, UpdateLogService>()

        /** One service per file, so every writer of it shares one thread and order. */
        internal fun forFile(file: File): UpdateLogService = services.getOrPut(file.path) { UpdateLogService(file) }

        /** Cuts every URL in [message] down to its host and bounds its length. */
        internal fun sanitizeMessage(message: String): String =
            URL_PATTERN
                .replace(message.take(MAX_RAW_MESSAGE_LENGTH), "$1$2")
                .take(MAX_MESSAGE_LENGTH)
    }

    // One thread, created when something is queued, that ends when idle.
    private val executor: ExecutorService =
        ThreadPoolExecutor(0, 1, 10, TimeUnit.SECONDS, LinkedBlockingQueue()) { task ->
            Thread(task, "hot-updater-update-log").apply { isDaemon = true }
        }

    // Only the executor's thread reads and writes it.
    private var appendsUntilTrim = 0

    internal fun append(event: UpdateLogEvent) {
        val timestamp = clock()
        submit { appendLine(lineOf(event, timestamp)) }
    }

    /** Appends one JSON entry of a check or download JavaScript ran, keeping only what the log knows. */
    internal fun appendJson(entry: String) {
        val timestamp = clock()
        submit {
            val event =
                try {
                    JSONObject(entry)
                } catch (_: JSONException) {
                    return@submit
                }
            val type = event.stringOrNull("type")?.takeIf { it in JAVASCRIPT_TYPES } ?: return@submit
            val outcome = event.stringOrNull("outcome") ?: return@submit
            appendLine(
                lineOf(
                    UpdateLogEvent(
                        type = type,
                        outcome = outcome,
                        bundleId = event.stringOrNull("bundleId"),
                        fromBundleId = event.stringOrNull("fromBundleId"),
                        releaseId = event.stringOrNull("releaseId"),
                        channel = event.stringOrNull("channel"),
                        error = event.optJSONObject("error"),
                    ),
                    timestamp,
                ),
            )
        }
    }

    /** The retained entries as a JSON array, oldest first. Waits, so never call it on the main thread. */
    internal fun read(): String =
        run(fallback = "[]") {
            JSONArray().apply { retainedLines().forEach { put(JSONObject(it)) } }.toString()
        }

    /** Deletes the log; false only when the file could not be deleted. */
    internal fun clear(): Boolean =
        run(fallback = false) {
            appendsUntilTrim = 0
            !file.exists() || file.delete()
        }

    private fun submit(action: () -> Unit) {
        try {
            executor.execute {
                try {
                    action()
                } catch (error: Exception) {
                    Log.w(TAG, "Failed to write the update log", error)
                }
            }
        } catch (error: Exception) {
            Log.w(TAG, "Failed to queue the update log entry", error)
        }
    }

    private fun <T> run(
        fallback: T,
        action: () -> T,
    ): T =
        try {
            executor.submit(Callable(action)).get()
        } catch (error: Exception) {
            Log.w(TAG, "Failed to read the update log", error)
            fallback
        }

    private fun appendLine(line: String) {
        file.parentFile?.mkdirs()
        if (appendsUntilTrim <= 0) {
            trim()
            appendsUntilTrim = TRIM_INTERVAL
        }
        appendsUntilTrim -= 1
        FileOutputStream(file, true).use { it.write("\n$line".toByteArray()) }
    }

    private fun trim() {
        val retained = retainedLines()
        if (!file.isFile) return
        val temporary = File(file.path + ".tmp")
        temporary.writeText(retained.joinToString(separator = "") { "\n$it" })
        if (!temporary.renameTo(file)) {
            temporary.delete()
        }
    }

    private fun retainedLines(): List<String> {
        if (!file.isFile) return emptyList()
        if (file.length() > MAX_FILE_BYTES) {
            file.delete()
            return emptyList()
        }
        val oldest = clock() - MAX_AGE_MILLIS
        return file
            .readLines()
            .filter { line ->
                val timestamp = parseTimestamp(line)
                timestamp != null && timestamp >= oldest
            }.takeLast(MAX_ENTRIES)
    }

    /** The entry's time, or null for a line that is not an entry. */
    private fun parseTimestamp(line: String): Long? {
        if (line.isEmpty()) return null
        return try {
            val entry = JSONObject(line)
            if (entry.optString("type").isEmpty() || !entry.has("timestamp")) null else entry.getLong("timestamp")
        } catch (_: JSONException) {
            null
        }
    }

    private fun lineOf(
        event: UpdateLogEvent,
        timestamp: Long,
    ): String =
        JSONObject()
            .put("timestamp", timestamp)
            .put("type", event.type)
            .put("outcome", bounded(event.outcome))
            .apply {
                event.bundleId?.let { put("bundleId", bounded(it)) }
                event.fromBundleId?.let { put("fromBundleId", bounded(it)) }
                event.releaseId?.let { put("releaseId", bounded(it)) }
                event.channel?.let { put("channel", bounded(it)) }
                event.error?.let { put("error", boundedError(it)) }
            }.toString()

    private fun bounded(value: String): String = value.take(MAX_FIELD_LENGTH)

    private fun boundedError(error: JSONObject): JSONObject =
        JSONObject().apply {
            ERROR_FIELDS.forEach { field -> error.stringOrNull(field)?.let { put(field, bounded(it)) } }
            error.stringOrNull("message")?.let { put("message", sanitizeMessage(it)) }
        }

    private fun JSONObject.stringOrNull(key: String): String? = if (isNull(key)) null else (opt(key) as? String)?.takeIf { it.isNotEmpty() }
}
