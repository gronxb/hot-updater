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

    // Serializes the launch's bundle selection with the update check's read
    // of it, so a check never reads metadata the launch is still selecting from.
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
     */
    internal constructor(
        context: Context,
        bundleStorage: BundleStorageService,
        preferences: PreferencesService,
        environment: HotUpdaterInstanceEnvironment,
        activityStartGate: ActivityStartGate? = null,
    ) {
        this.context = context.applicationContext
        // An activity started before this process followed activities is
        // known only from the context the app hands over.
        (context as? Activity)?.let(HotUpdaterRecoveryAttribution.shared::noteActivity)
        this.environment = environment
        this.bundleStorage = bundleStorage
        this.preferences = preferences
        this.recoveryManager = HotUpdaterRecoveryManager(this.context, environment)
        this.activityStartGate = activityStartGate ?: createActivityStartGate(this.context, environment)
        this.releaseCatalogCache =
            ReleaseCatalogCacheService(environment.releaseCatalogCacheDirectory(this.context))
        this.installIdentity = InstallIdentityService.create(this.context)
        this.keyValueStorage = KeyValueStorageService(environment.keyValueStorageFile(this.context))
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
    ) : this(
        context = context,
        bundleStorage = createBundleStorage(context, environment),
        preferences = createPreferences(context, environment),
        environment = environment,
        activityStartGate = activityStartGate,
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
        private const val DEFAULT_CHANNEL = "production"
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
        fun getFingerprintHash(context: Context): String? =
            NativeConfigUtils.getString(
                context,
                NativeConfigUtils.FINGERPRINT_HASH_META_DATA_KEY,
            )
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
        return prepareLaunchIfNeeded().bundleUrl
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

    suspend fun commitReleaseSelection(selection: PersistedSelection): Boolean = bundleStorage.commitReleaseSelection(selection)

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

            bundleStorage.settlePreviousLaunch { recoveryManager.consumePendingCrashRecovery() }
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
            val (selection, launch) = selectAndMonitorLaunchLocked()
            val now = launchInvalidations.get()
            if (now == invalidations) return publishLaunchLocked(selection, launch, invalidations)
            invalidations = now
        }
        val (selection, launch) = selectAndMonitorLaunchLocked()
        return publishLaunchLocked(selection, launch, invalidations)
    }

    private fun selectAndMonitorLaunchLocked(): Pair<LaunchSelection, Long> {
        val pendingRecovery = recoveryManager.consumePendingCrashRecovery()
        val selection = bundleStorage.prepareLaunch(pendingRecovery)
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
        return selection to launch
    }

    private fun publishLaunchLocked(
        selection: LaunchSelection,
        launch: Long,
        invalidations: Long,
    ): LaunchSelection {
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
