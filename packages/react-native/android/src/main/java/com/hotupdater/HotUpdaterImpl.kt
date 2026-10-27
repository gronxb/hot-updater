package com.hotupdater

import android.app.Activity
import android.app.ActivityOptions
import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Process
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicLong

/**
 * Core implementation class for HotUpdater functionality
 */
class HotUpdaterImpl {
    private val context: Context
    private val environment: HotUpdaterInstanceEnvironment
    private val bundleStorage: BundleStorageService
    private val preferences: PreferencesService

    // Each instance watches its own launch: its crash marker, and the launch
    // gate that waits for one of its own views.
    private val recoveryManager: HotUpdaterRecoveryManager
    private val activityStartGate: ActivityStartGate
    private val releaseCatalogCache: ReleaseCatalogCacheService
    private val installIdentity: InstallIdentityService
    private val keyValueStorage: KeyValueStorageService

    // Main's update check at the launch after a crash; null for a named instance.
    private val postCrashUpdateCheck: PostCrashUpdateCheck?

    // Read by native update checks on other threads while React Native sets it.
    @Volatile
    private var currentLaunchSelection: LaunchSelection? = null

    // The selection React Native runs in this process. A channel reset clears
    // currentLaunchSelection, so React Native's next read picks the default
    // channel's bundle, but the running bundle stays until a reload.
    @Volatile
    private var runningLaunchSelection: LaunchSelection? = null

    // Counts the crash markers written for this instance's launches. A
    // prepared launch keeps the count it started from: one written since,
    // even while it was being prepared, makes the next start prepare again,
    // which reads the marker. Crash recovery bumps it under its own lock, so
    // it never waits for the launch lock.
    private val launchInvalidations = AtomicLong()

    @Volatile
    private var currentLaunchInvalidations = 0L

    // The selection a named instance's monitored launch runs, with that
    // launch, under the launch lock.
    private var monitoredLaunch: Pair<LaunchSelection, Long>? = null

    // Serializes the launch's bundle selection with the update check's read
    // of it, so a check never reads metadata the launch is still selecting from,
    // and with a channel reset or built-in commit, which delete downloaded bundles.
    private val launchPreparationLock = Any()

    /**
     * Primary constructor with dependency injection (for testing)
     */
    constructor(
        context: Context,
        bundleStorage: BundleStorageService,
        preferences: PreferencesService,
    ) : this(context, bundleStorage, preferences, HotUpdaterInstanceEnvironment.main)

    /**
     * @param activityStartGate the gate that arms this instance's launch;
     * by default one that waits for a started activity showing one of its views
     * @param postCrashUpdateCheck main's check after a crash, over its
     * key-value store; by default one with main's native checker
     * @param isDevelopmentBuild a debug build, where a crash is a RedBox
     * during development, never a reason to check for a fix: main records no
     * crash after its grace period and has no check after a crash
     */
    internal constructor(
        context: Context,
        bundleStorage: BundleStorageService,
        preferences: PreferencesService,
        environment: HotUpdaterInstanceEnvironment,
        activityStartGate: ActivityStartGate? = null,
        postCrashUpdateCheck: ((KeyValueStorageService) -> PostCrashUpdateCheck)? = null,
        isDevelopmentBuild: Boolean = BuildConfig.DEBUG,
    ) {
        this.context = context.applicationContext
        // An activity started before this process followed activities is
        // known only from the context the app hands over.
        (context as? Activity)?.let(HotUpdaterRecoveryAttribution.shared::noteActivity)
        this.environment = environment
        this.bundleStorage = bundleStorage
        this.preferences = preferences
        this.recoveryManager =
            HotUpdaterRecoveryManager(this.context, environment, recordsCrashesAfterContent = !isDevelopmentBuild)
        this.activityStartGate = activityStartGate ?: createActivityStartGate(this.context, environment)
        this.releaseCatalogCache =
            ReleaseCatalogCacheService(environment.releaseCatalogCacheDirectory(this.context))
        this.installIdentity = InstallIdentityService.create(this.context)
        this.keyValueStorage = KeyValueStorageService(environment.keyValueStorageFile(this.context))
        this.postCrashUpdateCheck =
            if (environment.isMain && !isDevelopmentBuild) {
                (postCrashUpdateCheck ?: ::createPostCrashUpdateCheck)(keyValueStorage)
            } else {
                null
            }
    }

    /**
     * Convenience constructor for simple usage
     */
    constructor(context: Context) : this(context, HotUpdaterInstanceEnvironment.main)

    /** The impl of a named instance, or of main, with its own storage and configuration. */
    internal constructor(
        context: Context,
        environment: HotUpdaterInstanceEnvironment,
        activityStartGate: ActivityStartGate? = null,
        postCrashUpdateCheck: ((KeyValueStorageService) -> PostCrashUpdateCheck)? = null,
        isDevelopmentBuild: Boolean = BuildConfig.DEBUG,
    ) : this(
        context = context,
        bundleStorage = createBundleStorage(context, environment),
        preferences = createPreferences(context, environment),
        environment = environment,
        activityStartGate = activityStartGate,
        postCrashUpdateCheck = postCrashUpdateCheck,
        isDevelopmentBuild = isDevelopmentBuild,
    )

    /**
     * Checks with main's native checker, the one its native API and resetChannel
     * share, once a started activity of any kind shows UI: a headless launch,
     * such as a background push, leaves the check for a launch the user sees.
     * Its gate is created only when a check is due, so a process without one
     * follows no activities for it ([postCrashUiGate]).
     */
    private fun createPostCrashUpdateCheck(storage: KeyValueStorageService): PostCrashUpdateCheck =
        PostCrashUpdateCheck(
            getItem = storage::getItem,
            setItem = storage::setItem,
            whenUiShown = { action -> postCrashUiGate(context as? Application).runWhenActivityStarted(action) },
            check = { request ->
                NativeUpdateCheck.checker(context, HotUpdaterInstanceEnvironment.MAIN_NAME) { this }.checkForUpdate(request)
            },
            isRestartProcess = { HotUpdaterProcess.isRestartProcess(context) },
        )

    /**
     * Gets the app version
     * @param context Application context
     * @return App version name or null if not available
     */
    fun getAppVersion(): String? =
        try {
            val packageInfo =
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                    context.packageManager.getPackageInfo(
                        context.packageName,
                        android.content.pm.PackageManager.PackageInfoFlags
                            .of(0),
                    )
                } else {
                    @Suppress("DEPRECATION")
                    context.packageManager.getPackageInfo(context.packageName, 0)
                }
            packageInfo.versionName
        } catch (e: Exception) {
            null
        }

    companion object {
        private const val TAG = "HotUpdaterImpl"
        internal const val DEFAULT_CHANNEL = "production"
        private const val CHANNEL_STORAGE_KEY = "HotUpdaterChannel"

        // How many times one start prepares its launch while crashes of the
        // running launch keep writing markers.
        private const val MAX_LAUNCH_PREPARATIONS = 3

        /**
         * Create BundleStorageService with all dependencies
         */
        private fun createBundleStorage(
            context: Context,
            environment: HotUpdaterInstanceEnvironment,
        ): BundleStorageService {
            val appContext = context.applicationContext
            val fileSystem = FileManagerService(appContext, environment.filesRoot(appContext))
            val preferences = createPreferences(appContext, environment)
            val downloadService = OkHttpDownloadService()
            val isolationKey = environment.isolationKey(appContext)

            return BundleFileStorageService(
                appContext,
                fileSystem,
                downloadService,
                preferences,
                isolationKey,
                defaultChannelProvider = { environment.defaultChannel(appContext) },
                fingerprintHashProvider = { environment.fingerprintHash(appContext) },
                publicKeyProvider = { environment.publicKey(appContext) },
                fallbackBundleURL = environment.fallbackBundleURL,
            )
        }

        /**
         * A launch counts once a started activity shows one of the instance's
         * views. Main takes every view no named instance claims, so an app
         * with only main waits for any React Native view, as it always has,
         * and counts an activity started before the gate at once. A named
         * instance is often prepared while the app already shows other
         * screens, so it checks the activities already started for its view.
         */
        private fun createActivityStartGate(
            context: Context,
            environment: HotUpdaterInstanceEnvironment,
        ): ActivityStartGate {
            val attribution = HotUpdaterRecoveryAttribution.shared
            return ActivityStartGate(
                context as? Application,
                showsReactView = { activity -> attribution.showsViewOf(activity, environment.name) },
                activitiesStartedBefore = activitiesStartedBefore(environment, attribution),
                beforeCheckingViews = HotUpdaterRecoveryManager::resolveHeldContent,
            )
        }

        /**
         * The gate of the check after a crash: any started activity counts.
         * Created that late, it misses the start of an activity already
         * shown, so it also counts the ones the process has seen started;
         * an app without the ProcessLifecycleOwner initializer would
         * otherwise wait for another activity to start.
         */
        internal fun postCrashUiGate(
            application: Application?,
            attribution: HotUpdaterRecoveryAttribution = HotUpdaterRecoveryAttribution.shared,
            processLifecycleStarted: () -> Boolean = ::hasStartedActivity,
            mainThread: HotUpdaterMainThread = HotUpdaterMainThread.android,
        ): ActivityStartGate =
            ActivityStartGate(
                application,
                processHasStartedActivity = { processLifecycleStarted() || attribution.startedActivities().isNotEmpty() },
                showsReactView = { true },
                mainThread = mainThread,
            )

        /**
         * The activities already started that a gate created now checks for
         * the instance's view: a named instance's, while main counts any
         * started activity at once, as it always has (null).
         */
        internal fun activitiesStartedBefore(
            environment: HotUpdaterInstanceEnvironment,
            attribution: HotUpdaterRecoveryAttribution = HotUpdaterRecoveryAttribution.shared,
        ): (() -> Collection<Activity>)? = if (environment.isMain) null else attribution::startedActivities

        /**
         * Create PreferencesService with isolation key
         */
        private fun createPreferences(
            context: Context,
            environment: HotUpdaterInstanceEnvironment,
        ): PreferencesService {
            val appContext = context.applicationContext
            val isolationKey = environment.isolationKey(appContext)
            return VersionedPreferencesService(appContext, isolationKey, environment.preferencesPrefix)
        }

        fun getAppVersion(context: Context): String? =
            try {
                val packageInfo =
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                        context.packageManager.getPackageInfo(
                            context.packageName,
                            android.content.pm.PackageManager.PackageInfoFlags
                                .of(0),
                        )
                    } else {
                        @Suppress("DEPRECATION")
                        context.packageManager.getPackageInfo(context.packageName, 0)
                    }
                packageInfo.versionName
            } catch (e: Exception) {
                null
            }

        fun getChannel(context: Context): String =
            NativeConfigUtils.getString(
                context,
                NativeConfigUtils.CHANNEL_META_DATA_KEY,
            ) ?: DEFAULT_CHANNEL

        /**
         * The bundle ID of the bundle this build ships (MIN_BUNDLE_ID),
         * written by the generateHotUpdaterMinBundleId build task
         */
        fun getMinBundleId(): String {
            if (BuildConfig.DEBUG) {
                return "00000000-0000-0000-0000-000000000000"
            }
            return HotUpdaterMinBundleId.get()
        }

        /**
         * Gets the current fingerprint hash
         * @param context Application context
         * @return The fingerprint hash or null if not set
         */
        fun getFingerprintHash(
            @Suppress("UNUSED_PARAMETER") context: Context,
        ): String? = resolveFingerprintHash()

        /**
         * The programmatic override (brownfield/AAR setups, see HotUpdaterConfig),
         * else the fingerprint the build embedded, written by the
         * generateHotUpdaterFingerprintHash build task.
         */
        private fun resolveFingerprintHash(): String? =
            HotUpdaterConfig.fingerprintHash?.takeIf { it.isNotEmpty() }
                ?: HotUpdaterConfig.buildFingerprintHash
    }

    /**
     * Gets the current fingerprint hash
     * @return The fingerprint hash or null if not set
     */
    fun getFingerprintHash(): String? = environment.fingerprintHash(context)

    /**
     * Gets the current update channel
     * @return The channel name or null if not set
     */
    fun getChannel(): String {
        val activeSelection = bundleStorage.getActiveUpdateState()["activeSelection"] as? Map<*, *>
        val receiptChannel = activeSelection?.get("channel") as? String
        if (!receiptChannel.isNullOrEmpty()) {
            return receiptChannel
        }
        val overriddenChannel = preferences.getItem(CHANNEL_STORAGE_KEY)
        if (!overriddenChannel.isNullOrEmpty()) {
            return overriddenChannel
        }

        return environment.defaultChannel(context)
    }

    fun getDefaultChannel(): String = environment.defaultChannel(context)

    /**
     * Gets the path to the bundle file
     * @return The path to the bundle file
     */
    fun getJSBundleFile(): String {
        // Hot Updater's restart process only relaunches the app; preparing a
        // launch there would consume the crash marker and launch state the
        // relaunched process needs.
        if (HotUpdaterProcess.isRestartProcess(context)) {
            return bundleStorage.getFallbackBundleURL()
        }
        val bundleUrl = prepareLaunchIfNeeded().bundleUrl
        // Outside the launch's locks, after any rollback its preparation made.
        postCrashUpdateCheck?.startIfPending()
        return bundleUrl
    }

    /**
     * Updates the bundle from its manifest and complete asset descriptors.
     * @param bundleId ID of the bundle to update
     * @param manifestUrl URL of the target manifest
     * @param manifestFileHash Hash or signature used to verify the target manifest
     * @param assets Complete target asset descriptor map
     * @param progressCallback Callback for download progress updates
     * @return how the staged bundle arrived
     * @throws HotUpdaterException if the update fails
     */
    suspend fun updateBundle(
        bundleId: String,
        manifestUrl: String,
        manifestFileHash: String,
        assets: Map<String, ChangedAssetDescriptor>,
        channel: String?,
        selection: PersistedSelection? = null,
        archiveUrl: String? = null,
        fileResolver: ArtifactFileResolver? = null,
        progressCallback: (UpdateProgressPayload) -> Unit,
    ): UpdateBundleResult {
        val result =
            bundleStorage.updateBundle(
                bundleId = bundleId,
                manifestUrl = manifestUrl,
                manifestFileHash = manifestFileHash,
                assets = assets,
                archiveUrl = archiveUrl,
                fileResolver = fileResolver,
                selection = selection,
                progressCallback = progressCallback,
            )

        if (!channel.isNullOrEmpty()) {
            if (channel == getDefaultChannel()) {
                preferences.setItem(CHANNEL_STORAGE_KEY, null)
            } else {
                preferences.setItem(CHANNEL_STORAGE_KEY, channel)
            }
        }
        return result
    }

    /**
     * Restarts the app process so the next launch loads the current bundle.
     * @param reactContext The original context (preferably ReactApplicationContext to get current activity)
     */
    suspend fun reload(reactContext: Context) {
        try {
            withContext(Dispatchers.Main) {
                if (!restartApplication(reactContext)) {
                    throw IllegalStateException("Process restart could not be started")
                }
            }
            currentLaunchSelection = null
            runningLaunchSelection = null
        } catch (e: Exception) {
            Log.e("HotUpdaterImpl", "Failed to restart application process", e)
            throw e
        }
    }

    // A cold restart, so applying a bundle does not depend on React Native reload timing.
    private fun restartApplication(reactContext: Context): Boolean {
        val applicationContext = reactContext.applicationContext
        val currentActivity =
            (reactContext as? com.facebook.react.bridge.ReactApplicationContext)?.currentActivity

        return try {
            val restartIntent =
                Intent(applicationContext, HotUpdaterRestartActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION)
                    putExtra(HotUpdaterRestartActivity.EXTRA_PACKAGE_NAME, applicationContext.packageName)
                    putExtra(HotUpdaterRestartActivity.EXTRA_TARGET_PID, Process.myPid())
                }
            if (currentActivity != null) {
                val options = ActivityOptions.makeCustomAnimation(currentActivity, 0, 0)
                currentActivity.startActivity(restartIntent, options.toBundle())
            } else {
                applicationContext.startActivity(restartIntent)
            }

            Log.i(TAG, "Started restart trampoline to apply update bundle")
            return true
        } catch (e: Exception) {
            Log.w(TAG, "Failed to start restart trampoline", e)
            false
        }
    }

    fun notifyAppReady(): Map<String, Any?> = bundleStorage.notifyAppReady()

    fun acceptReleaseCatalog(
        catalogId: String,
        scopeKey: String,
        generation: Long,
        catalogHash: String,
        channel: String,
        selectionContextHash: String,
    ): Boolean =
        bundleStorage.acceptReleaseCatalog(
            catalogId,
            scopeKey,
            generation,
            catalogHash,
            channel,
            selectionContextHash,
        )

    fun getActiveUpdateState(): Map<String, Any?> = bundleStorage.getActiveUpdateState()

    fun getReleaseCatalogCache(partition: String): String? = releaseCatalogCache.get(partition)

    fun setReleaseCatalogCache(
        partition: String,
        payload: String,
    ): Boolean = releaseCatalogCache.set(partition, payload)

    fun removeReleaseCatalogCache(partition: String): Boolean = releaseCatalogCache.remove(partition)

    fun isReleaseSelectionCurrent(
        catalogId: String,
        scopeKey: String,
        generation: Long,
        catalogHash: String,
        channel: String,
        selectionContextHash: String,
    ): Boolean =
        bundleStorage.isReleaseSelectionCurrent(
            catalogId,
            scopeKey,
            generation,
            catalogHash,
            channel,
            selectionContextHash,
        )

    suspend fun commitReleaseSelection(selection: PersistedSelection): Boolean {
        if (selection.kind == "BUNDLE") return bundleStorage.commitReleaseSelection(selection)

        // Committing the built-in bundle deletes every downloaded bundle, so it
        // runs under the launch lock as a channel reset does: React Native never
        // selects a bundle the commit is about to delete, and its next read picks
        // the built-in bundle. The storage commit runs on another IO thread, so
        // blocking this one cannot deadlock.
        return withContext(Dispatchers.IO) {
            synchronized(launchPreparationLock) {
                val committed = runBlocking { bundleStorage.commitReleaseSelection(selection) }
                if (committed) {
                    currentLaunchSelection = null
                }
                committed
            }
        }
    }

    fun getInstallId(): String = installIdentity.getInstallId()

    /** Reads a value from the client plugins' key-value store. */
    fun getStorageItem(key: String): String? = keyValueStorage.getItem(key)

    /** Writes a value to the client plugins' key-value store; null removes the key. */
    fun setStorageItem(
        key: String,
        value: String?,
    ) {
        keyValueStorage.setItem(key, value)
    }

    /**
     * Gets the crashed bundle history.
     * @return List of crashed bundle IDs
     */
    fun getCrashHistory(): List<String> = bundleStorage.getCrashHistory().bundles.map { it.bundleId }

    /**
     * Clears the crashed bundle history.
     * @return true if clearing was successful
     */
    fun clearCrashHistory(): Boolean = bundleStorage.clearCrashHistory()

    /**
     * Gets the base URL for the current active bundle directory.
     * Returns the file:// URL to the bundle directory with trailing slash.
     * This is used for Expo DOM components to construct full asset paths.
     * @return Base URL string (e.g., "file:///data/.../bundle-store/abc123/") or null
     */
    fun getBaseURL(): String? {
        val launchSelection = currentLaunchSelection
        if (launchSelection != null) {
            val baseURL = bundleStorage.getBaseURLForBundle(launchSelection.launchedBundleId)
            return baseURL
                .takeIf { it.isNotEmpty() }
        }

        return null
    }

    /**
     * Gets the current launched bundle ID.
     * Built-in bundle fallback is handled in JS.
     */
    fun getBundleId(): String? {
        val launchSelection = currentLaunchSelection
        if (launchSelection != null) {
            return launchSelection.launchedBundleId
        }

        return null
    }

    /**
     * The bundle this process runs. A channel reset clears [currentLaunchSelection]
     * for the next launch, but the running bundle stays until React Native reloads.
     */
    fun getRunningBundleId(): String? = (currentLaunchSelection ?: runningLaunchSelection)?.launchedBundleId

    /** Takes the queued native update events for JavaScript's `takeNativeUpdateEvents`. */
    fun takeNativeUpdateEvents(): String? =
        NativeUpdateEventQueue(::getStorageItem, ::setStorageItem, build = {
            NativeUpdateEventQueue.buildOf(getAppVersion(), getMinBundleId(), CohortService(context).getCohort())
        }).take()

    /**
     * The bundle the native update check counts as running: the launched one,
     * or before React Native starts, the one its launch would pick. Before
     * React Native starts, what the previous process left is settled first, so
     * the check reads the selection, launch state, and crash history the
     * launch will use. Preparing the launch here would arm crash monitoring and
     * keep a forced update staged before React Native starts from applying in
     * this process.
     */
    fun getBundleIdForUpdateCheck(): String? =
        synchronized(launchPreparationLock) {
            val launchSelection = currentLaunchSelection ?: runningLaunchSelection
            if (launchSelection != null) {
                return@synchronized launchSelection.launchedBundleId
            }

            bundleStorage.settlePreviousLaunch { consumePendingCrashRecovery() }
            bundleStorage.peekLaunchBundleId()
        }

    /**
     * Gets the current manifest from bundle storage.
     */
    fun getManifest(): Map<String, Any?> {
        val launchSelection = currentLaunchSelection
        if (launchSelection != null) {
            return bundleStorage.getManifestForBundle(launchSelection.launchedBundleId)
        }

        return emptyMap()
    }

    suspend fun resetChannel(): Boolean =
        withContext(Dispatchers.IO) {
            // Under the launch lock, so React Native never selects a bundle the
            // reset is about to delete. The storage reset runs on another IO
            // thread, so blocking this one cannot deadlock.
            synchronized(launchPreparationLock) {
                val success = runBlocking { bundleStorage.resetChannel() }
                if (success) {
                    preferences.setItem(CHANNEL_STORAGE_KEY, null)
                    currentLaunchSelection = null
                }
                success
            }
        }

    /**
     * Resets the channel while the Release selection [guard] names is
     * current, as [resetChannel] does; false for a stale one.
     */
    internal suspend fun resetChannelIfSelectionCurrent(guard: ReleaseSelectionGuard): Boolean =
        withContext(Dispatchers.IO) {
            synchronized(launchPreparationLock) {
                val success =
                    runBlocking {
                        bundleStorage.resetChannelIfSelectionCurrent(
                            catalogId = guard.catalogId,
                            scopeKey = guard.scopeKey,
                            generation = guard.generation,
                            catalogHash = guard.catalogHash,
                            channel = guard.channel,
                            selectionContextHash = guard.selectionContextHash,
                        )
                    }
                if (success) {
                    preferences.setItem(CHANNEL_STORAGE_KEY, null)
                    currentLaunchSelection = null
                }
                success
            }
        }

    private fun prepareLaunchIfNeeded(): LaunchSelection =
        synchronized(launchPreparationLock) {
            prepareLaunchLocked()
        }

    private fun prepareLaunchLocked(): LaunchSelection {
        var invalidations = launchInvalidations.get()
        currentLaunchSelection?.takeIf { currentLaunchInvalidations == invalidations }?.let { return it }

        // The running launch's crash may write its marker while this one is
        // prepared, after the marker was read: the selection would launch
        // the failing bundle again. Its monitoring is replaced only once the
        // new launch's starts, so the count is checked after that, and the
        // launch prepared again, reading the marker, while it changed. A
        // crash can't recur faster than a launch is prepared; should it, the
        // latest selection goes, and the count it started from has the next
        // start prepare again.
        repeat(MAX_LAUNCH_PREPARATIONS - 1) {
            val prepared = selectAndMonitorLaunchLocked()
            val now = launchInvalidations.get()
            if (now == invalidations) return publishLaunchLocked(prepared, invalidations)
            invalidations = now
        }
        return publishLaunchLocked(selectAndMonitorLaunchLocked(), invalidations)
    }

    private class PreparedLaunch(
        val selection: LaunchSelection,
        val launch: Long,
        /** False when the selection continues the launch already monitored. */
        val started: Boolean,
    )

    /**
     * Whether [next] continues the named instance's launch of [current]
     * rather than starting another: the same bundle, from the same URL,
     * still unverified, or verified since. A launch's state is its bundle's
     * persisted verification, so the same bundle selected again in this
     * process, as after a reset that keeps it or a reload before the
     * process restarts, is the same launch; another one would make its
     * runtimes, which load the same URL, look like a replacement's.
     */
    private fun continuesLaunch(
        current: LaunchSelection,
        next: LaunchSelection,
    ): Boolean =
        current.launchedBundleId == next.launchedBundleId &&
            current.bundleUrl == next.bundleUrl &&
            (current.shouldRollbackOnCrash || !next.shouldRollbackOnCrash)

    /**
     * Keeps a native check's request the server answered for main's check
     * after a crash, as JavaScript's checks do; an app that checks only
     * natively has no other. Nothing for a named instance or in a debug
     * build, which have no such check.
     */
    internal fun recordRecoveryRequest(request: NativeCheckRequest) {
        if (postCrashUpdateCheck == null) return
        keyValueStorage.setItem(RecoveryCheckConfig.KEY, RecoveryCheckConfig.of(request).toJson())
    }

    /**
     * Reads and deletes the crash marker the previous launch left. One that
     * doesn't ask to roll back means the bundle that crashed runs again, so
     * main checks for a fix natively once a launch shows UI
     * ([PostCrashUpdateCheck]); recorded before this launch goes on, as the
     * marker is already gone. One that asks to roll back is settled locally,
     * with any check an earlier crash left pending: the restored bundle
     * passed its own first content.
     */
    private fun consumePendingCrashRecovery(): PendingCrashRecovery? =
        recoveryManager.consumePendingCrashRecovery()?.also {
            if (it.shouldRollback) postCrashUpdateCheck?.clearPending() else postCrashUpdateCheck?.markPending()
        }

    private fun selectAndMonitorLaunchLocked(): PreparedLaunch {
        val pendingRecovery = consumePendingCrashRecovery()
        val selection = bundleStorage.prepareLaunch(pendingRecovery)
        monitoredLaunch?.let { (current, launch) ->
            if (!environment.isMain && continuesLaunch(current, selection) && recoveryManager.monitorsLaunch(launch)) {
                return PreparedLaunch(selection, launch, started = false)
            }
        }
        val launch =
            recoveryManager.startMonitoring(
                bundleId = selection.launchedBundleId,
                shouldRollback = selection.shouldRollbackOnCrash,
                onContentAppeared = { launchedBundleId ->
                    bundleStorage.markLaunchCompleted(launchedBundleId)
                },
                onCrashOfAnotherInstance = { launchedBundleId ->
                    bundleStorage.clearLaunchStarted(launchedBundleId)
                },
                // Restarting the app restarts main's host. A named instance's
                // crash leaves its marker for its next launch to roll back.
                onRecoveryRestartRequested =
                    if (environment.isMain) {
                        { restartApplication(context) }
                    } else {
                        null
                    },
                onRuntimeActivity = activityStartGate::watchActivity,
                launchURL = selection.bundleUrl,
                onCharged = { launchInvalidations.incrementAndGet() },
            )
        return PreparedLaunch(selection, launch, started = true)
    }

    private fun publishLaunchLocked(
        prepared: PreparedLaunch,
        invalidations: Long,
    ): LaunchSelection {
        val selection = prepared.selection
        val launch = prepared.launch
        monitoredLaunch = selection to launch
        // A launch continued keeps its gate, which may have armed it already.
        if (!prepared.started) {
            runningLaunchSelection = selection
            currentLaunchInvalidations = invalidations
            currentLaunchSelection = selection
            return selection
        }
        // A headless JS task, such as a background push, loads the bundle without
        // an activity and never renders. Only a launch with an activity may leave
        // an unfinished launch for the next process to roll back. A named
        // runtime may also be pre-warmed while the app shows other screens, so
        // its launch waits for one of its own views.
        activityStartGate.runWhenActivityStarted(
            if (selection.shouldRollbackOnCrash) {
                {
                    recoveryManager.armLaunch(launch) { bundleStorage.markLaunchStarted(selection.launchedBundleId) }
                }
            } else {
                null
            },
        )
        runningLaunchSelection = selection
        currentLaunchInvalidations = invalidations
        currentLaunchSelection = selection
        return selection
    }
}
