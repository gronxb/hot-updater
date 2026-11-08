package com.hotupdater

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

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
 * The list lives in memory behind one lock, held only to read it, to change it
 * with the renames that go with the change, and to write it. Copying, checking,
 * measuring and deleting files run outside the lock: a copy goes to a partial
 * directory the shelf marks as in progress, and what goes is first renamed
 * aside. The process holds one shelf and calls it off the main thread.
 */
internal class HotUpdaterSandboxShelf(
    /** The shelf's directory. */
    val root: File,
    /** Main's bundle store, which holds each just-installed bundle under its ID. */
    val source: File,
    val isolationKey: String,
) {
    private val lock = Any()

    /** The list, read from disk once. */
    private var cached: List<HotUpdaterSandboxShelfEntry>? = null

    /** Bundles being copied, whose partial directories reconciliation leaves alone. */
    private val copying = HashSet<String>()

    /** Newest first. */
    val entries: List<HotUpdaterSandboxShelfEntry>
        get() = synchronized(lock) { list() }

    /** Under the lock. */
    private fun list(): List<HotUpdaterSandboxShelfEntry> =
        cached ?: runCatching {
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
        }.getOrDefault(emptyList()).also { cached = it }

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
    ) {
        if (!isName(bundleId)) return
        val partial = File(root, "$bundleId$PARTIAL")
        synchronized(lock) { copying += bundleId }
        partial.deleteRecursively()
        val copied =
            try {
                File(source, bundleId).copyRecursively(partial, overwrite = true)
                (check(partial, bundleId) != null).also { if (!it) Log.w(TAG, "didn't keep $bundleId: it isn't a whole bundle") }
            } catch (error: Exception) {
                Log.w(TAG, "didn't keep $bundleId: ${error.message}")
                false
            }
        val trash =
            synchronized(lock) {
                copying -= bundleId
                if (!copied) return@synchronized emptyList()
                val aside = listOfNotNull(setAside(bundleId))
                if (!partial.renameTo(directory(bundleId))) {
                    Log.w(TAG, "didn't keep $bundleId: it couldn't be moved in")
                    return@synchronized aside
                }
                aside + publish(bundleId, channel, message, nowMs, running)
            }
        delete(trash + partial)
    }

    /** Under the lock: the new list, and what its change set aside. */
    private fun publish(
        bundleId: String,
        channel: String,
        message: String?,
        nowMs: Long,
        running: String?,
    ): List<File> {
        val next =
            (
                listOf(HotUpdaterSandboxShelfEntry(bundleId, channel, message, isolationKey, nowMs)) +
                    list().filter { it.bundleId != bundleId }
            ).toMutableList()
        val trash = mutableListOf<File>()
        while (next.size > LIMIT) {
            val oldest = next.filter { it.bundleId != running }.minByOrNull { it.downloadedAtMs } ?: break
            next.remove(oldest)
            setAside(oldest.bundleId)?.let(trash::add)
        }
        write(next)
        return trash
    }

    /**
     * The bundle's files when they're all on this device, checked as main checks a
     * launch. Read outside the lock: a bundle removed meanwhile reads as gone.
     */
    fun stored(bundleId: String): HotUpdaterSandboxStoredBundle? = if (isName(bundleId)) check(directory(bundleId), bundleId) else null

    fun remove(bundleId: String) {
        if (!isName(bundleId)) return
        val trash =
            synchronized(lock) {
                write(list().filter { it.bundleId != bundleId })
                setAside(bundleId)
            }
        delete(listOfNotNull(trash))
    }

    /** Everything but what runs, or is about to. */
    fun clear(kept: Set<String>) {
        val trash =
            synchronized(lock) {
                val all = list()
                write(all.filter { it.bundleId in kept })
                all.filter { it.bundleId !in kept }.mapNotNull { setAside(it.bundleId) }
            }
        delete(trash)
    }

    /** Another build's entries go, and so do partial copies and files no entry names. */
    fun reconcile() {
        val trash =
            synchronized(lock) {
                val all = list()
                val kept = all.filter { it.isolationKey == isolationKey }
                if (kept.size != all.size) write(kept)
                val names = kept.map { it.bundleId }.toSet()
                val inProgress = copying.map { "$it$PARTIAL" }.toSet()
                root
                    .listFiles()
                    .orEmpty()
                    .filter { it.name != INDEX && it.name !in names && it.name !in inProgress }
                    // Leftover trash goes as it is.
                    .mapNotNull { if (it.name.startsWith(TRASH)) it else setAside(it.name) }
            }
        delete(trash)
    }

    /** What the stored copies take, in bytes. Measured outside the lock. */
    fun totalBytes(): Long =
        entries.sumOf { entry ->
            directory(entry.bundleId).walkTopDown().filter { it.isFile }.sumOf { it.length() }
        }

    private fun directory(name: String) = File(root, name)

    /** Under the lock: moves a directory out of the list's way by one rename, for deleting after the lock. */
    private fun setAside(name: String): File? {
        val trash = File(root, "$TRASH${UUID.randomUUID()}")
        return trash.takeIf { directory(name).renameTo(it) }
    }

    private fun delete(files: List<File>) = files.forEach { it.deleteRecursively() }

    /** Under the lock. Best effort, like the copies: a full cache loses the list, never the switch. */
    private fun write(entries: List<HotUpdaterSandboxShelfEntry>) {
        cached = entries
        runCatching { writeIndex(entries) }.onFailure { Log.w(TAG, "didn't save the list: ${it.message}") }
    }

    private fun writeIndex(entries: List<HotUpdaterSandboxShelfEntry>) {
        check(root.isDirectory || root.mkdirs()) { "no shelf directory" }
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
        if (!partial.renameTo(File(root, INDEX))) {
            partial.delete()
            error("the list couldn't be moved in")
        }
    }

    companion object {
        const val LIMIT = 10
        private const val TAG = "HotUpdaterSandbox"
        private const val INDEX = "index.json"
        private const val PARTIAL = ".tmp"
        private const val TRASH = ".trash-"

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
