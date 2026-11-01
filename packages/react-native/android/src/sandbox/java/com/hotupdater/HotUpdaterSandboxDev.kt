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

private const val TAG = "HotUpdaterSandboxDev"

/** A dev server's files on this device, outside the OTA store. */
internal data class HotUpdaterSandboxDevSession(
    val id: String,
    val host: String,
    val bundle: File,
)

/**
 * A relaunch into a dev session. The relaunch's helper process writes it while
 * it lives and stays until it is read, so a process that finds the helper gone
 * wasn't started by it: a claim alone never arms a launch.
 */
internal data class HotUpdaterSandboxDevClaim(
    val sessionId: String,
    val host: String,
    val witnessPid: Int,
    val elapsedRealtime: Long,
) {
    fun toJson(): String =
        JSONObject()
            .put("sessionId", sessionId)
            .put("host", host)
            .put("witnessPid", witnessPid)
            .put("elapsedRealtime", elapsedRealtime)
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
                )
            }.getOrNull()
    }
}

/** The dev server's directory, and the rule for what a starting process finds in it. */
internal class HotUpdaterSandboxDevFiles(
    val root: File,
) {
    val claim: File get() = File(root, CLAIM)
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
     */
    fun takeSession(
        isWitnessAlive: (Int) -> Boolean,
        elapsedRealtime: Long,
    ): HotUpdaterSandboxDevSession? {
        val file = claim
        if (!file.isFile) return null
        val claim = runCatching { HotUpdaterSandboxDevClaim.parse(file.readText()) }.getOrNull()
        file.delete()
        if (claim == null) return null
        val age = elapsedRealtime - claim.elapsedRealtime
        if (age < 0 || age > CLAIM_MAX_AGE_MS || !isWitnessAlive(claim.witnessPid)) {
            Log.i(TAG, "dropped a claim nobody relaunched this process for")
            return null
        }
        val bundle = bundle(claim.sessionId)
        if (!bundle.isFile) {
            Log.w(TAG, "dropped a claim without its bundle")
            return null
        }
        return HotUpdaterSandboxDevSession(claim.sessionId, claim.host, bundle)
    }

    /** What no running process needs: everything, or all but `running`'s. */
    fun staleEntries(running: HotUpdaterSandboxDevSession?): List<File> =
        if (running == null) {
            root.listFiles()?.toList().orEmpty()
        } else {
            File(root, SESSIONS).listFiles()?.filter { it.name != running.id }.orEmpty()
        }

    companion object {
        private const val CLAIM = "claim.json"
        private const val KEY_VALUE = "storage.json"
        private const val SESSIONS = "sessions"
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
 * [storage], [preferences], [keyValueFile] and [relaunch].
 */
internal object HotUpdaterSandboxDev {
    /** A channel no release targets, so a check from dev JavaScript finds nothing to apply. */
    const val DEV_CHANNEL = "hot-updater-sandbox-dev-server"

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
        return name == packageName
    }

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
                    session = files.takeSession({ isWitnessAlive(context, it) }, SystemClock.elapsedRealtime())
                    val stale = files.staleEntries(session)
                    if (stale.isNotEmpty()) {
                        Thread { stale.forEach(File::deleteRecursively) }.start()
                    }
                }
            }
            settled = true
            Log.i(TAG, "this process runs ${session?.let { "the dev server's ${it.host}" } ?: "the normal selection"}")
            session
        }
    }

    fun bundleOfThisProcess(context: Context): String? = session(context)?.bundle?.absolutePath

    fun storage(
        context: Context,
        environment: HotUpdaterInstanceEnvironment,
        storage: BundleStorageService,
    ): BundleStorageService {
        if (!environment.isMain) return storage
        normalStorage = storage
        return if (session(context) != null) HotUpdaterSandboxDevStorage(storage) else storage
    }

    fun preferences(
        context: Context,
        environment: HotUpdaterInstanceEnvironment,
        preferences: PreferencesService,
    ): PreferencesService {
        if (!environment.isMain) return preferences
        normalPreferences = preferences
        return if (session(context) != null) HotUpdaterSandboxDevPreferences(preferences) else preferences
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

    /**
     * `reload()` from dev JavaScript stays in this session. False in a normal
     * process, whose restart goes on as usual.
     */
    fun relaunch(context: Context): Boolean {
        val running = session(context) ?: return false
        startRelaunch(context, HotUpdaterSandboxRelaunch.Dev(running.id, running.host))
        return true
    }

    /** Replaces this process: with [HotUpdaterSandboxRelaunch.Dev]'s session, or the first screen. */
    fun startRelaunch(
        context: Context,
        relaunch: HotUpdaterSandboxRelaunch,
    ) {
        val intent =
            Intent(context.applicationContext, HotUpdaterSandboxRelaunchActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
                .putExtra(HotUpdaterSandboxRelaunchActivity.EXTRA_TARGET_PID, Process.myPid())
        if (relaunch is HotUpdaterSandboxRelaunch.Dev) {
            intent
                .putExtra(HotUpdaterSandboxRelaunchActivity.EXTRA_SESSION, relaunch.sessionId)
                .putExtra(HotUpdaterSandboxRelaunchActivity.EXTRA_HOST, relaunch.host)
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
    ): UpdateBundleResult = UpdateBundleResult(BundleDelivery.ARCHIVE, false)

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

    override suspend fun commitReleaseSelection(selection: PersistedSelection): Boolean = true

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

    override suspend fun resetChannel(): Boolean = true

    override suspend fun resetChannelIfSelectionCurrent(
        catalogId: String,
        scopeKey: String,
        generation: Long,
        catalogHash: String,
        channel: String,
        selectionContextHash: String,
    ): Boolean = true
}

/** Main's preferences in a dev session: a channel without releases, and no writes. */
internal class HotUpdaterSandboxDevPreferences(
    private val normal: PreferencesService,
) : PreferencesService {
    override fun getItem(key: String): String? =
        if (key == HotUpdaterSandboxDev.CHANNEL_STORAGE_KEY) HotUpdaterSandboxDev.DEV_CHANNEL else normal.getItem(key)

    override fun setItem(
        key: String,
        value: String?,
    ) = Unit
}
