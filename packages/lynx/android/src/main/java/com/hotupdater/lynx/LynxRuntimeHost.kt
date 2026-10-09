package com.hotupdater.lynx

import android.content.Context
import android.os.Process
import com.hotupdater.lynx.internal.ArchiveIntegrity
import com.hotupdater.lynx.internal.HashUtils
import java.io.File
import java.lang.ref.WeakReference
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

internal fun lynxScopeDirectory(
    filesDir: File,
    binaryId: String,
    embedded: VerifiedLynxInstallation,
    configuration: LynxHostConfiguration,
): File {
    val keyIdentity = ArchiveIntegrity(configuration.publicKeyPem).keyIdentity
    val namespace = digestString(listOf(binaryId, configuration.runtimeId, configuration.channel,
        configuration.appVersion, embedded.bundleId, embedded.manifestHash, keyIdentity).joinToString("\n"))
    return File(filesDir, "hot-updater-lynx/scopes/$namespace").canonicalFile
}

/** Serializes foreground ownership and detached background snapshots for one native scope. */
class LynxRuntimeHost internal constructor(
    private val filesDir: File,
    private val packageCodePath: File,
    private val embedded: VerifiedLynxInstallation,
    val configuration: LynxHostConfiguration,
    private val processIdentity: () -> String = { Process.myPid().toString() },
    private val processToken: String = LynxUpdaterController.PROCESS_TOKEN,
    private val binaryId: String = HashUtils.calculateSHA256(packageCodePath),
) {
    private val directory = lynxScopeDirectory(filesDir, binaryId, embedded, configuration)
    private val ownerLock = Any()
    // Controller admission and task reservations share one linearization point.
    internal val stateLock = Any()
    private data class Task(
        val snapshot: LynxBackgroundSnapshot,
        var fatal: String? = null,
        var persisted: Boolean = false,
        var detached: Boolean = false,
    )
    private val tasks = linkedMapOf<String, Task>()
    private var foreground: LynxUpdaterController? = null

    /** Runs the declared standalone background entry; closing requests cancellation, never readiness. */
    fun runBackground(context: Context, completion: (Result<LynxBackgroundResult>) -> Unit): AutoCloseable =
        LynxBackgroundExecutor(context, this, completion)

    fun createForeground(): LynxUpdaterController = synchronized(ownerLock) {
        synchronized(stateLock) {
            check(foreground == null) { "This Lynx scope already has a foreground owner" }
            replayColdFailures()
        }
        // Installer initialization takes its own lock. Never hold stateLock here.
        LynxUpdaterController(filesDir, packageCodePath, embedded, configuration, processIdentity, processToken,
            runtimeHost = this, binaryId = binaryId).also { foreground = it }
    }

    internal fun closeForeground(controller: LynxUpdaterController) = synchronized(ownerLock) {
        check(controller.runtimeHost === this) { "A different Lynx host owns this controller" }
        try {
            controller.closeOwned()
        } finally {
            if (foreground === controller) foreground = null
        }
    }

    internal fun backgroundSnapshot(): LynxBackgroundSnapshot = captureBackground(reserve = false)

    internal fun beginBackground(): LynxBackgroundTask =
        LynxBackgroundTask(captureBackground(reserve = true), this)

    private fun captureBackground(reserve: Boolean): LynxBackgroundSnapshot = synchronized(ownerLock) {
        foreground?.let { return@synchronized it.backgroundSnapshot(reserve) }
        synchronized(stateLock) {
            replayColdFailures()
            val store = LynxStateStore(directory, readOnly = true)
            try {
                if (reserve) requireTaskSlot()
                val selected = LynxStoredSelectionReader(store.value, directory, embedded, configuration, binaryId)
                    .backgroundSelection(processToken, cold = true)
                LynxBackgroundSnapshot.copy(selected.first, selected.second).also {
                    if (reserve) reserveBackground(it, store.value, null)
                }
            } finally { store.close() }
        }
    }

    /** Caller holds stateLock, including at final foreground pin/adoption. */
    internal fun reservedReleases(state: JSONObject, live: CatalogPolicy.Receipt?): Set<String> {
        check(Thread.holdsLock(stateLock))
        val permanent = state.optJSONArray("unconfirmed")
        val ids = (0 until (permanent?.length() ?: 0)).map { permanent!!.getString(it) }.toMutableSet()
        state.optJSONObject("interruptedReleases")?.keys()?.forEach(ids::add)
        for (key in listOf("pending", "pageAttempt", "generationFailure")) {
            state.optJSONObject(key)?.getJSONObject("selection")?.let(CatalogPolicy::parseReceipt)?.releaseId?.let(ids::add)
        }
        live?.releaseId?.let(ids::add)
        tasks.values.mapNotNullTo(ids) { it.snapshot.selection.releaseId }
        return ids
    }

    internal fun requireTaskSlot() {
        check(Thread.holdsLock(stateLock))
        check(tasks.size < 4) { "Too many concurrent Lynx background tasks" }
    }

    internal fun reserveBackground(snapshot: LynxBackgroundSnapshot, state: JSONObject, live: CatalogPolicy.Receipt?) {
        requireTaskSlot()
        val ids = reservedReleases(state, live) + listOfNotNull(snapshot.selection.releaseId)
        check(ids.size <= LynxStoredSelectionReader.RECOVERY_CAPACITY) { "Background recovery capacity exhausted" }
        check(tasks.values.none { it.fatal != null && !it.persisted }) { "A background failure has not been persisted" }
        check(tasks.put(snapshot.taskId, Task(snapshot)) == null)
        synchronized(hosts) { retainedHosts.add(this) }
    }

    internal fun finishBackground(taskId: String, fatal: String?, detached: Boolean) = synchronized(ownerLock) {
        synchronized(stateLock) taskLock@{
            val task = tasks[taskId] ?: return@taskLock false
            if (fatal != null && task.fatal == null) task.fatal = fatal
            if (detached) task.detached = true
            // Normal completion cannot discard a failed runtime's pending write.
            if (task.fatal != null && !task.persisted) {
                foreground?.replayBackgroundFailures() ?: replayColdFailures()
            }
            if (task.detached && (task.fatal == null || task.persisted)) {
                tasks.remove(taskId)
                releaseRetentionIfIdle()
            }
            true
        }
    }

    private fun replayColdFailures() {
        check(Thread.holdsLock(stateLock))
        if (tasks.values.none { it.fatal != null && !it.persisted }) return
        val store = LynxStateStore(directory)
        try { persistBackgroundFailures(store) } finally { store.close() }
    }

    internal fun hasPendingFailure(bundleId: String): Boolean {
        check(Thread.holdsLock(stateLock))
        return tasks.values.any { it.fatal != null && it.snapshot.selection.bundleId == bundleId }
    }

    /** Does not consume or replace another runtime's pending/readiness/transition records. */
    internal fun persistBackgroundFailures(store: LynxStateStore) {
        check(Thread.holdsLock(stateLock))
        val failed = tasks.filterValues { it.fatal != null && !it.persisted }
        if (failed.isEmpty()) return
        store.update { next ->
            val permanent = next.optJSONArray("unconfirmed")
            val ids = (0 until (permanent?.length() ?: 0)).map { permanent!!.getString(it) }.toMutableSet()
            val crashed = next.optJSONArray("crashed")
            val bundles = (0 until (crashed?.length() ?: 0)).map { crashed!!.getString(it) }.toMutableList()
            val retries = next.optJSONObject("interruptedReleases") ?: JSONObject()
            for (task in failed.values) {
                val receipt = task.snapshot.selection
                receipt.releaseId?.let { ids.add(it); retries.remove(it) }
                retries.keys().asSequence().toList().forEach { id ->
                    if (retries.getJSONObject(id).getString("bundleId") == receipt.bundleId) {
                        ids.add(id)
                        retries.remove(id)
                    }
                }
                if (receipt.bundleId == embedded.bundleId) {
                    val previous = next.optJSONObject("failedEmbedded")?.let(CatalogPolicy::parseReceipt)
                    // A signed embedded Release must not resurrect an already-failed builtin.
                    next.put("failedEmbedded", retainEmbeddedFailure(previous, receipt).toJson())
                } else {
                    bundles.remove(receipt.bundleId)
                    bundles.add(receipt.bundleId)
                }
            }
            check((ids + retries.keys().asSequence().toSet()).size <= LynxStoredSelectionReader.RECOVERY_CAPACITY) {
                "Missing reserved background recovery capacity"
            }
            // Match the existing bounded Bundle cache; permanent Release exclusions are never evicted.
            while (bundles.size > 10) bundles.removeAt(0)
            next.put("crashed", JSONArray(bundles))
            next.put("unconfirmed", JSONArray(ids.toList()))
            next.put("interruptedReleases", retries)
            next.put("revision", UUID.randomUUID().toString())
        }
        failed.forEach { (id, task) ->
            task.persisted = true
            if (task.detached) tasks.remove(id)
        }
        releaseRetentionIfIdle()
    }

    private fun releaseRetentionIfIdle() {
        if (tasks.isEmpty()) synchronized(hosts) { retainedHosts.remove(this) }
    }

    companion object {
        private val hosts = mutableMapOf<String, WeakReference<LynxRuntimeHost>>()
        private val retainedHosts = mutableSetOf<LynxRuntimeHost>()

        internal fun requireNoBackgroundTasks(directory: File) {
            // Never acquire a host lock while holding the global registry lock.
            val active = synchronized(hosts) { retainedHosts.filter { it.directory == directory } }
            for (host in active) synchronized(host.stateLock) {
                check(host.tasks.isEmpty()) { "Use LynxRuntimeHost.createForeground while background tasks are active" }
            }
        }

        /** Supply the same native configuration from foreground and OS task entry points. */
        @JvmStatic fun get(context: Context, configuration: LynxHostConfiguration): LynxRuntimeHost {
            val app = context.applicationContext
            val binaryId = HashUtils.calculateSHA256(File(app.packageCodePath))
            val embedded = loadEmbedded(app, configuration)
            val directory = lynxScopeDirectory(app.filesDir, binaryId, embedded, configuration)
            synchronized(hosts) {
                hosts.entries.removeAll { it.value.get() == null }
                hosts[directory.path]?.get()?.let {
                    check(it.configuration == configuration) { "Native configuration changed for an owned Lynx scope" }
                    return it
                }
                return LynxRuntimeHost(app.filesDir, File(app.packageCodePath), embedded, configuration, binaryId = binaryId).also {
                    hosts[directory.path] = WeakReference(it)
                }
            }
        }
    }
}
