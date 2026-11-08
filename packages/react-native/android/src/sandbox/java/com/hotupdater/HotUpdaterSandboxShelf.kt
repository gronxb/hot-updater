package com.hotupdater

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** A bundle a sandbox switch downloaded, as the Downloaded list keeps it. */
internal data class HotUpdaterSandboxShelfEntry(
    val bundleId: String,
    val channel: String,
    /** The deploy message, when the check named one. */
    val message: String?,
    /** Main's key when it was downloaded: another build's bundles don't run here. */
    val isolationKey: String,
    val downloadedAtMs: Long,
)

/** A stored bundle's files, checked: what a stored session runs. */
internal data class HotUpdaterSandboxStoredBundle(
    val bundleId: String,
    /** The JavaScript file. */
    val bundle: File,
    /** `file://` and the bundle's directory, as main answers `getBaseURL`. */
    val baseURL: String,
    val manifest: Map<String, Any?>,
)

/**
 * The sandbox's own copies of what its switches downloaded, in the cache
 * directory of the `.sandbox` app. Main's store is only read. A row whose files
 * are gone checks its channel instead.
 *
 * Every read and write runs under one lock: a copy runs off the main thread, and
 * a refresh or a Clear must never see half of one. The process holds one shelf.
 */
internal class HotUpdaterSandboxShelf(
    /** The shelf's directory. */
    val root: File,
    /** Main's bundle store, which holds each just-installed bundle under its ID. */
    val source: File,
    val isolationKey: String,
) {
    private val lock = Any()

    /** Newest first. */
    val entries: List<HotUpdaterSandboxShelfEntry>
        get() = synchronized(lock) { readEntries() }

    private fun readEntries(): List<HotUpdaterSandboxShelfEntry> =
        runCatching {
            val items = JSONArray(File(root, INDEX).readText())
            (0 until items.length()).map { index ->
                val item = items.getJSONObject(index)
                HotUpdaterSandboxShelfEntry(
                    bundleId = item.getString("bundleId"),
                    channel = item.getString("channel"),
                    message = item.optString("message").takeIf { item.has("message") },
                    isolationKey = item.getString("isolationKey"),
                    downloadedAtMs = item.getLong("downloadedAtMs"),
                )
            }
        }.getOrDefault(emptyList())

    /**
     * Lists a bundle main just installed, with a copy. Best effort: a copy that
     * fails its check lists nothing. The oldest entry past the cap goes, never
     * [running]'s.
     */
    fun add(
        bundleId: String,
        channel: String,
        message: String?,
        nowMs: Long,
        running: String?,
    ): Unit =
        synchronized(lock) {
            addHolding(bundleId, channel, message, nowMs, running)
        }

    private fun addHolding(
        bundleId: String,
        channel: String,
        message: String?,
        nowMs: Long,
        running: String?,
    ) {
        if (!isName(bundleId) || !copy(bundleId)) return
        val next =
            (
                listOf(HotUpdaterSandboxShelfEntry(bundleId, channel, message, isolationKey, nowMs)) +
                    readEntries().filter { it.bundleId != bundleId }
            ).toMutableList()
        while (next.size > LIMIT) {
            val oldest = next.filter { it.bundleId != running }.minByOrNull { it.downloadedAtMs } ?: break
            next.remove(oldest)
            directory(oldest.bundleId).deleteRecursively()
        }
        write(next)
    }

    /** The bundle's files when they're all on this device, checked as main checks a launch. */
    fun stored(bundleId: String): HotUpdaterSandboxStoredBundle? =
        if (isName(bundleId)) synchronized(lock) { check(directory(bundleId), bundleId) } else null

    fun remove(bundleId: String) {
        if (!isName(bundleId)) return
        synchronized(lock) {
            directory(bundleId).deleteRecursively()
            write(readEntries().filter { it.bundleId != bundleId })
        }
    }

    /** Everything but what runs. */
    fun clear(running: String?): Unit =
        synchronized(lock) {
            val all = readEntries()
            all.filter { it.bundleId != running }.forEach { directory(it.bundleId).deleteRecursively() }
            write(all.filter { it.bundleId == running })
        }

    /** Another build's entries go, and so do partial copies and files no entry names. */
    fun reconcile(): Unit = synchronized(lock) { reconcileHolding() }

    private fun reconcileHolding() {
        val all = readEntries()
        val kept = all.filter { it.isolationKey == isolationKey }
        if (kept.size != all.size) write(kept)
        val names = kept.map { it.bundleId }.toSet()
        root.listFiles()?.filter { it.name != INDEX && it.name !in names }?.forEach { it.deleteRecursively() }
    }

    /** What the stored copies take, in bytes. */
    fun totalBytes(): Long =
        synchronized(lock) { readEntries() }.sumOf { entry ->
            directory(entry.bundleId).walkTopDown().filter { it.isFile }.sumOf { it.length() }
        }

    private fun directory(bundleId: String) = File(root, bundleId)

    /** Copies main's directory beside the shelf, checks it, then renames it in. */
    private fun copy(bundleId: String): Boolean {
        val partial = File(root, "$bundleId$PARTIAL")
        partial.deleteRecursively()
        return try {
            root.mkdirs()
            File(source, bundleId).copyRecursively(partial, overwrite = true)
            check(check(partial, bundleId) != null) { "it isn't a whole bundle" }
            directory(bundleId).deleteRecursively()
            check(partial.renameTo(directory(bundleId))) { "it couldn't be moved in" }
            true
        } catch (error: Exception) {
            partial.deleteRecursively()
            Log.w(TAG, "didn't keep $bundleId: ${error.message}")
            false
        }
    }

    private fun write(entries: List<HotUpdaterSandboxShelfEntry>) {
        root.mkdirs()
        val items =
            JSONArray(
                entries.map {
                    JSONObject()
                        .put("bundleId", it.bundleId)
                        .put("channel", it.channel)
                        .put("message", it.message)
                        .put("isolationKey", it.isolationKey)
                        .put("downloadedAtMs", it.downloadedAtMs)
                },
            )
        val partial = File(root, "$INDEX$PARTIAL")
        partial.writeText(items.toString())
        if (!partial.renameTo(File(root, INDEX))) partial.delete()
    }

    companion object {
        const val LIMIT = 10
        private const val TAG = "HotUpdaterSandbox"
        private const val INDEX = "index.json"
        private const val PARTIAL = ".tmp"

        /** A bundle ID that names one directory of the shelf. */
        private fun isName(bundleId: String) =
            bundleId.isNotEmpty() && !bundleId.startsWith(".") && !bundleId.contains('/') && !bundleId.endsWith(PARTIAL)

        /**
         * The manifest names the bundle, each asset it lists is a regular file inside
         * the directory, and exactly one of them is the JavaScript.
         */
        fun check(
            directory: File,
            bundleId: String,
        ): HotUpdaterSandboxStoredBundle? {
            val manifest = runCatching { JSONObject(File(directory, "manifest.json").readText()) }.getOrNull() ?: return null
            if (manifest.optString("bundleId").trim() != bundleId) return null
            val assets = manifest.optJSONObject("assets") ?: return null
            val root = directory.canonicalFile
            val bundles = mutableListOf<File>()
            for (path in assets.keys()) {
                val relative = RelativePathResolver.normalizeRelativePath(path) ?: return null
                val file = File(directory, relative)
                // A link resolves elsewhere, so it is never the regular file listed.
                if (!file.isFile || file.canonicalPath != File(root, relative).path) return null
                if (file.name.endsWith(".android.bundle")) bundles += file
            }
            val bundle = bundles.singleOrNull() ?: return null
            return HotUpdaterSandboxStoredBundle(bundleId, bundle, "file://${directory.absolutePath}", toMap(manifest))
        }

        private fun toMap(json: JSONObject): Map<String, Any?> = json.keys().asSequence().associateWith { toValue(json.get(it)) }

        private fun toValue(value: Any?): Any? =
            when (value) {
                JSONObject.NULL -> null
                is JSONObject -> toMap(value)
                is JSONArray -> (0 until value.length()).map { toValue(value.get(it)) }
                else -> value
            }
    }
}
