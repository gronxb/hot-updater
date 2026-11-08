package com.hotupdater

import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.util.UUID

private const val TAG = "HotUpdaterSandboxDev"

/**
 * What a session process runs, outside the OTA store: a dev server's files, or
 * with [stored], a bundle of the Downloaded list.
 */
internal data class HotUpdaterSandboxDevSession(
    val id: String,
    val host: String,
    val bundle: File,
    val stored: HotUpdaterSandboxStoredBundle? = null,
)

/**
 * A relaunch into a session: a dev server's, or with [storedBundleId], a stored
 * bundle's. The relaunch's helper process writes it while it lives and stays
 * until it is read, so a process that finds the helper gone wasn't started by
 * it: a claim alone never arms a launch.
 */
internal data class HotUpdaterSandboxDevClaim(
    val sessionId: String,
    val host: String,
    val witnessPid: Int,
    val elapsedRealtime: Long,
    val storedBundleId: String? = null,
) {
    fun toJson(): String =
        JSONObject()
            .put("sessionId", sessionId)
            .put("host", host)
            .put("witnessPid", witnessPid)
            .put("elapsedRealtime", elapsedRealtime)
            .put("storedBundleId", storedBundleId)
            .toString()

    companion object {
        fun parse(text: String): HotUpdaterSandboxDevClaim? =
            runCatching {
                val json = JSONObject(text)
                HotUpdaterSandboxDevClaim(
                    sessionId = json.getString("sessionId"),
                    host = json.getString("host"),
                    witnessPid = json.getInt("witnessPid"),
                    elapsedRealtime = json.getLong("elapsedRealtime"),
                    storedBundleId = json.optString("storedBundleId").takeIf { json.has("storedBundleId") },
                )
            }.getOrNull()
    }
}

/** The dev server's directory, and the rule for what a starting process finds in it. */
internal class HotUpdaterSandboxDevFiles(
    val root: File,
) {
    val claim: File get() = File(root, CLAIM)

    /**
     * A stored session's relaunch, on its way: a file named by its token. Only the
     * request with that token may act, and only once.
     */
    fun writeHandoff(token: String) {
        root.mkdirs()
        root.listFiles()?.filter { it.name.startsWith(HANDOFF) || it.name.startsWith(HANDOFF_WON) }?.forEach { it.delete() }
        check(File(root, "$HANDOFF$token").createNewFile()) { "Couldn't write the relaunch's handoff" }
    }

    /**
     * Takes the handoff of [token], once, for whichever side asks first: the helper
     * that relaunches, or the screen that calls it off. An exclusive create succeeds
     * for one caller only, across processes, so the two can't both win.
     */
    fun claimHandoff(token: String?): Boolean =
        token != null &&
            File(root, "$HANDOFF$token").exists() &&
            runCatching { File(root, "$HANDOFF_WON$token").createNewFile() }.getOrDefault(false)

    val keyValueFile: File get() = File(root, KEY_VALUE)

    fun session(id: String): File = File(root, "$SESSIONS/$id")

    fun bundle(id: String): File = File(session(id), BUNDLE)

    /** Writes the claim whole, so a reader never sees half of one. */
    fun writeClaim(claim: HotUpdaterSandboxDevClaim) {
        root.mkdirs()
        val partial = File(root, "$CLAIM.tmp")
        partial.writeText(claim.toJson())
        check(partial.renameTo(this.claim)) { "Couldn't write the relaunch's claim" }
    }

    /**
     * The session a starting process runs, once. The claim goes either way, so
     * the launch after this one can't take it, whatever happens to this one.
     * It goes only after the helper is checked: the helper lives until it's gone.
     */
    fun takeSession(
        isWitnessAlive: (Int) -> Boolean,
        elapsedRealtime: Long,
        stored: (String) -> HotUpdaterSandboxStoredBundle? = { null },
    ): HotUpdaterSandboxDevSession? {
        val file = claim
        if (!file.isFile) return null
        try {
            val claim = runCatching { HotUpdaterSandboxDevClaim.parse(file.readText()) }.getOrNull() ?: return null
            val age = elapsedRealtime - claim.elapsedRealtime
            if (age < 0 || age > CLAIM_MAX_AGE_MS || !isWitnessAlive(claim.witnessPid)) {
                Log.i(TAG, "dropped a claim nobody relaunched this process for")
                return null
            }
            if (claim.storedBundleId != null) {
                val bundle = stored(claim.storedBundleId)
                if (bundle == null) Log.w(TAG, "dropped a claim whose stored bundle is gone")
                return bundle?.let { HotUpdaterSandboxDevSession(claim.sessionId, claim.host, it.bundle, it) }
            }
            val bundle = bundle(claim.sessionId)
            if (!bundle.isFile) {
                Log.w(TAG, "dropped a claim without its bundle")
                return null
            }
            return HotUpdaterSandboxDevSession(claim.sessionId, claim.host, bundle)
        } finally {
            file.delete()
        }
    }

    /** What no running process needs: everything, or all but `running`'s. */
    private fun staleEntries(running: HotUpdaterSandboxDevSession?): List<File> =
        if (running == null) {
            root.listFiles()?.filter { it.name != TRASH }.orEmpty()
        } else {
            File(root, SESSIONS).listFiles()?.filter { it.name != running.id }.orEmpty()
        }

    /**
     * Moves what no running process needs into the trash, each by one rename, and
     * returns what to delete: this move, and any a killed process left. A session
     * fetched afterwards is a new directory, so deleting these can't reach it. An
     * entry that won't move stays for the next launch, never deleted in place.
     */
    fun retireStale(running: HotUpdaterSandboxDevSession?): List<File> {
        val trash = File(root, TRASH)
        val left = trash.listFiles()?.toList().orEmpty()
        val stale = staleEntries(running)
        if (stale.isEmpty()) return left
        val batch = File(trash, UUID.randomUUID().toString())
        if (!batch.mkdirs()) return left
        stale.forEach { entry ->
            if (!entry.renameTo(File(batch, entry.name))) Log.w(TAG, "left ${entry.name} for the next launch")
        }
        return left + batch
    }

    companion object {
        private const val CLAIM = "claim.json"
        private const val HANDOFF = "handoff-"
        private const val HANDOFF_WON = "won-"
        private const val KEY_VALUE = "storage.json"
        private const val SESSIONS = "sessions"
        private const val TRASH = "trash"
        const val BUNDLE = "index.android.bundle"

        /** A relaunch that takes longer than this is treated as abandoned. */
        const val CLAIM_MAX_AGE_MS = 30_000L
    }
}

/**
 * What this process runs, settled once, before anything can read a bundle: a
 * provider asks first, and a host reading the bundle even earlier settles it
 * itself. It never changes afterwards, so connecting, reloading and leaving are
 * all a new process. A crash starts nothing: the next process finds no claim.
 *
 * The generated `HotUpdaterImpl` is the only caller of [bundleOfThisProcess],
 * [storedBundle], [storage], [preferences], [keyValueFile] and [relaunch].
 */
internal object HotUpdaterSandboxDev {
    /** A channel no release targets, so a check from dev JavaScript finds nothing to apply. */
    const val DEV_CHANNEL = "hot-updater-sandbox-dev-server"

    /** The same for a stored bundle's JavaScript. */
    const val STORED_CHANNEL = "hot-updater-sandbox-stored-bundle"

    @Volatile
    private var settled = false
    private var session: HotUpdaterSandboxDevSession? = null

    /** The real storage and preferences, for the sandbox's own view of the normal selection. */
    @Volatile
    private var normalStorage: BundleStorageService? = null

    @Volatile
    private var normalPreferences: PreferencesService? = null

    private fun files(context: Context): HotUpdaterSandboxDevFiles? =
        context.applicationContext?.filesDir?.let {
            HotUpdaterSandboxDevFiles(File(it, "hot-updater-sandbox-dev"))
        }

    private fun isMainProcess(context: Context): Boolean {
        val packageName = context.packageName ?: return false
        val name =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                Application.getProcessName()
            } else {
                runCatching { File("/proc/self/cmdline").readText().trimEnd('\u0000') }.getOrNull()
            }
        return isMainProcessName(context.applicationInfo?.processName, packageName, name)
    }

    /**
     * The app's own process: the one its `<application android:process>` names, the
     * package name without one. The relaunch helper's process never is.
     */
    fun isMainProcessName(
        applicationProcess: String?,
        packageName: String,
        processName: String?,
    ): Boolean =
        processName != null &&
            processName == (applicationProcess ?: packageName) &&
            !HotUpdaterProcess.isRestartProcessName(packageName, processName)

    private fun isWitnessAlive(
        context: Context,
        pid: Int,
    ): Boolean {
        val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return false
        return manager.runningAppProcesses.orEmpty().any { process ->
            process.pid == pid && HotUpdaterProcess.isRestartProcessName(context.packageName, process.processName)
        }
    }

    /** The session this process runs, or null for the normal selection. */
    fun session(context: Context): HotUpdaterSandboxDevSession? {
        if (settled) return session
        return synchronized(this) {
            if (settled) return@synchronized session
            // Another process of the app reads nothing and leaves the claim alone.
            if (isMainProcess(context)) {
                files(context)?.let { files ->
                    session =
                        files.takeSession(
                            { isWitnessAlive(context, it) },
                            SystemClock.elapsedRealtime(),
                            { shelf(context).listedAtStart(it) },
                        )
                    val retired = files.retireStale(session)
                    if (retired.isNotEmpty()) {
                        Thread { retired.forEach(File::deleteRecursively) }.start()
                    }
                }
            }
            settled = true
            Log.i(
                TAG,
                "this process runs ${session?.let {
                    it.stored?.let { "stored ${it.bundleId}" } ?: "the dev server's ${it.host}"
                } ?: "the normal selection"}",
            )
            session
        }
    }

    fun bundleOfThisProcess(context: Context): String? = session(context)?.bundle?.absolutePath

    /**
     * What a stored session runs, for main's `getBundleId`, `getBaseURL` and
     * `getManifest`. Nullable, so an impl built without its constructor reads null.
     */
    fun storedBundle(
        context: Context?,
        environment: HotUpdaterInstanceEnvironment?,
    ): HotUpdaterSandboxStoredBundle? = if (context != null && environment?.isMain == true) storedBundle(context) else null

    fun storedBundle(context: Context): HotUpdaterSandboxStoredBundle? = session(context)?.stored

    @Volatile
    private var shelf: HotUpdaterSandboxShelf? = null

    /** The Downloaded list's one shelf, in the `.sandbox` app's cache directory. */
    fun shelf(context: Context): HotUpdaterSandboxShelf =
        shelf ?: synchronized(this) {
            shelf ?: run {
                val app = context.applicationContext ?: context
                HotUpdaterSandboxShelf(
                    root = File(app.cacheDir, "hot-updater-sandbox-bundles"),
                    source = File(app.filesDir, "bundle-store"),
                    isolationKey = HotUpdaterInstanceEnvironment.main.isolationKey(app),
                ).also { shelf = it }
            }
        }

    fun storage(
        context: Context,
        environment: HotUpdaterInstanceEnvironment,
        storage: BundleStorageService,
    ): BundleStorageService {
        if (!environment.isMain) return storage
        normalStorage = storage
        val running = session(context) ?: return storage
        return if (running.stored != null) {
            HotUpdaterSandboxDevStorage(storage, "A stored bundle installs no updates. Go back to the current bundle first.")
        } else {
            HotUpdaterSandboxDevStorage(storage)
        }
    }

    fun preferences(
        context: Context,
        environment: HotUpdaterInstanceEnvironment,
        preferences: PreferencesService,
    ): PreferencesService {
        if (!environment.isMain) return preferences
        normalPreferences = preferences
        val running = session(context) ?: return preferences
        return HotUpdaterSandboxDevPreferences(preferences, if (running.stored != null) STORED_CHANNEL else DEV_CHANNEL)
    }

    /** A dev session's plugin values and server config stay out of the app's own. */
    fun keyValueFile(
        context: Context,
        environment: HotUpdaterInstanceEnvironment,
    ): File {
        val files = if (environment.isMain && session(context) != null) files(context) else null
        return files?.keyValueFile?.also { it.parentFile?.mkdirs() } ?: environment.keyValueStorageFile(context)
    }

    /** A running launch's "started" mark, so leaving for a dev session doesn't read as its crash. */
    fun clearNormalLaunchStarted(bundleId: String?) {
        normalStorage?.clearLaunchStarted(bundleId)
    }

    /** What a normal launch selects next, without settling anything, as read in a dev session. */
    fun normalSelection(): Pair<String?, String?>? {
        val storage = normalStorage ?: return null
        val activeSelection = storage.getActiveUpdateState()["activeSelection"] as? Map<*, *>
        val channel =
            (activeSelection?.get("channel") as? String)?.takeIf { it.isNotEmpty() }
                ?: normalPreferences?.getItem(CHANNEL_STORAGE_KEY)?.takeIf { it.isNotEmpty() }
        return storage.peekLaunchBundleId() to channel
    }

    /** What the normal selection's store holds, as read in a dev session. */
    fun normalActiveState(): Map<String, Any?>? = normalStorage?.getActiveUpdateState()

    /**
     * `reload()` from dev JavaScript stays in this session. False in a normal
     * process, whose restart goes on as usual.
     */
    fun relaunch(context: Context): Boolean {
        val running = session(context) ?: return false
        val stored = running.stored
        startRelaunch(
            context,
            if (stored != null) {
                HotUpdaterSandboxRelaunch.Stored(stored.bundleId, UUID.randomUUID().toString())
            } else {
                HotUpdaterSandboxRelaunch.Dev(running.id, running.host)
            },
        )
        return true
    }

    /** Replaces this process: with a session, or the first screen. */
    fun startRelaunch(
        context: Context,
        relaunch: HotUpdaterSandboxRelaunch,
    ) {
        val intent =
            Intent(context.applicationContext, HotUpdaterSandboxRelaunchActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
                .putExtra(HotUpdaterSandboxRelaunchActivity.EXTRA_TARGET_PID, Process.myPid())
        when (relaunch) {
            is HotUpdaterSandboxRelaunch.Dev ->
                intent
                    .putExtra(HotUpdaterSandboxRelaunchActivity.EXTRA_SESSION, relaunch.sessionId)
                    .putExtra(HotUpdaterSandboxRelaunchActivity.EXTRA_HOST, relaunch.host)
            is HotUpdaterSandboxRelaunch.Stored -> {
                // Recorded before the request goes out, so the screen can call it off.
                filesOf(context).writeHandoff(relaunch.token)
                intent
                    .putExtra(HotUpdaterSandboxRelaunchActivity.EXTRA_STORED_BUNDLE, relaunch.bundleId)
                    .putExtra(HotUpdaterSandboxRelaunchActivity.EXTRA_HANDOFF, relaunch.token)
            }
            HotUpdaterSandboxRelaunch.FirstScreen -> Unit
        }
        Log.i(TAG, "relaunching: $relaunch")
        context.applicationContext.startActivity(intent)
    }

    fun filesOf(context: Context): HotUpdaterSandboxDevFiles =
        files(context) ?: throw IllegalStateException("This app has no files directory")

    /** `HotUpdaterImpl`'s key for a runtime channel switch. */
    const val CHANNEL_STORAGE_KEY = "HotUpdaterChannel"
}

internal sealed class HotUpdaterSandboxRelaunch {
    data class Dev(
        val sessionId: String,
        val host: String,
    ) : HotUpdaterSandboxRelaunch()

    data class Stored(
        val bundleId: String,
        /** What the screen can call off: see [HotUpdaterSandboxDevFiles.claimHandoff]. */
        val token: String,
    ) : HotUpdaterSandboxRelaunch()

    object FirstScreen : HotUpdaterSandboxRelaunch()
}

/**
 * Main's storage in a dev session, where nothing but the normal selection's own
 * launch may read or write its state: writes do nothing, and reads say this
 * process has no downloaded bundle. Every method is spelled out, so an SDK that
 * adds a required one fails to compile here rather than reach the real store.
 */
internal class HotUpdaterSandboxDevStorage(
    private val normal: BundleStorageService,
    private val noInstall: String = "A dev session installs no updates. Exit the dev server first.",
) : BundleStorageService {
    override fun setBundleURL(localPath: String?): Boolean = false

    override fun getCachedBundleURL(): String? = null

    override fun getFallbackBundleURL(): String = normal.getFallbackBundleURL()

    override fun prepareLaunch(pendingRecovery: PendingCrashRecovery?): LaunchSelection =
        LaunchSelection(normal.getFallbackBundleURL(), null, false)

    override fun settlePreviousLaunch(pendingRecovery: () -> PendingCrashRecovery?) = Unit

    override fun peekLaunchBundleId(): String? = null

    override suspend fun updateBundle(
        bundleId: String,
        manifestUrl: String,
        manifestFileHash: String,
        assets: Map<String, ChangedAssetDescriptor>,
        archiveUrl: String?,
        fileResolver: ArtifactFileResolver?,
        selection: PersistedSelection?,
        progressCallback: (UpdateProgressPayload) -> Unit,
    ): UpdateBundleResult =
        // Any result would make its JavaScript take the request's channel: a session
        // installs nothing, so it says so the way a failed download does.
        throw HotUpdaterException("UNKNOWN_ERROR", noInstall)

    override fun acceptReleaseCatalog(
        catalogId: String,
        scopeKey: String,
        generation: Long,
        catalogHash: String,
        channel: String,
        selectionContextHash: String,
    ): Boolean = true

    override fun getActiveUpdateState(): Map<String, Any?> =
        mapOf(
            "activeSelection" to null,
            "stableSelection" to null,
            "verificationPending" to false,
            "highestSeenCatalogs" to emptyMap<String, Any?>(),
        )

    override fun isReleaseSelectionCurrent(
        catalogId: String,
        scopeKey: String,
        generation: Long,
        catalogHash: String,
        channel: String,
        selectionContextHash: String,
    ): Boolean = true

    override suspend fun commitReleaseSelection(selection: PersistedSelection): Boolean = false

    override fun markLaunchStarted(launchedBundleId: String?) = Unit

    override fun clearLaunchStarted(launchedBundleId: String?) = Unit

    override fun markLaunchCompleted(currentBundleId: String?) = Unit

    override fun notifyAppReady(): Map<String, Any?> = mapOf("status" to "UNCHANGED")

    override fun getCrashHistory(): CrashedHistory = CrashedHistory()

    override fun clearCrashHistory(): Boolean = true

    override fun getBaseURL(): String = ""

    override fun getBaseURLForBundle(bundleId: String?): String = ""

    override fun getBundleId(): String? = null

    override fun getManifest(): Map<String, Any?> = emptyMap()

    override fun getManifestForBundle(bundleId: String?): Map<String, Any?> = emptyMap()

    // Nothing changed, which keeps the session's channel in its JavaScript: true would
    // make it take the build's default channel and check the normal catalog.
    override suspend fun resetChannel(): Boolean = false

    override suspend fun resetChannelIfSelectionCurrent(
        catalogId: String,
        scopeKey: String,
        generation: Long,
        catalogHash: String,
        channel: String,
        selectionContextHash: String,
    ): Boolean = false
}

/** Main's preferences in a session: a channel without releases, and no writes. */
internal class HotUpdaterSandboxDevPreferences(
    private val normal: PreferencesService,
    private val channel: String = HotUpdaterSandboxDev.DEV_CHANNEL,
) : PreferencesService {
    override fun getItem(key: String): String? = if (key == HotUpdaterSandboxDev.CHANNEL_STORAGE_KEY) channel else normal.getItem(key)

    override fun setItem(
        key: String,
        value: String?,
    ) = Unit
}
