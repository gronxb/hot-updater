package com.hotupdater

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Core implementation class for HotUpdater functionality
 */
class HotUpdaterImpl {
    private val context: Context
    private val bundleStorage: BundleStorageService
    private val preferences: PreferencesService

    /**
     * Primary constructor with dependency injection (for testing)
     */
    constructor(
        context: Context,
        bundleStorage: BundleStorageService,
        preferences: PreferencesService,
    ) {
        this.context = context.applicationContext
        this.bundleStorage = bundleStorage
        this.preferences = preferences
    }

    /**
     * Convenience constructor for simple usage
     */
    constructor(context: Context) : this(
        context = context,
        bundleStorage = createBundleStorage(context),
        preferences = createPreferences(context),
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

        /**
         * Create BundleStorageService with all dependencies
         */
        private fun createBundleStorage(context: Context): BundleStorageService {
            val appContext = context.applicationContext
            val fileSystem = FileManagerService(appContext)
            val preferences = createPreferences(appContext)
            val downloadService = OkHttpDownloadService()
            val decompressService = DecompressService()
            val isolationKey = getIsolationKey(appContext)

            return BundleFileStorageService(
                appContext,
                fileSystem,
                downloadService,
                decompressService,
                preferences,
                isolationKey,
            )
        }

        /**
         * Create PreferencesService with isolation key
         */
        private fun createPreferences(context: Context): PreferencesService {
            val appContext = context.applicationContext
            val isolationKey = getIsolationKey(appContext)
            return VersionedPreferencesService(appContext, isolationKey)
        }

        /**
         * Gets the complete isolation key for preferences storage
         * @param context Application context
         * @return The isolation key in format: HotUpdaterPrefs_{fingerprintOrVersion}_{channel}
         */
        private fun getIsolationKey(context: Context): String {
            // Get fingerprint hash directly from resources
            val fingerprintId = StringResourceUtils.getIdentifier(context, "hot_updater_fingerprint_hash")
            val fingerprintHash =
                if (fingerprintId != 0) {
                    context.getString(fingerprintId).takeIf { it.isNotEmpty() }
                } else {
                    null
                }

            // Get app version and channel
            val appVersion = getAppVersion(context) ?: "unknown"
            val appChannel = getChannel(context)

            // Include both fingerprint hash and app version for complete isolation
            val baseKey =
                if (!fingerprintHash.isNullOrEmpty()) {
                    "${fingerprintHash}_$appVersion"
                } else {
                    appVersion
                }

            return "HotUpdaterPrefs_${baseKey}_$appChannel"
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

        fun getChannel(context: Context): String {
            val id = StringResourceUtils.getIdentifier(context, "hot_updater_channel")
            return if (id != 0) {
                context.getString(id).takeIf { it.isNotEmpty() } ?: DEFAULT_CHANNEL
            } else {
                DEFAULT_CHANNEL
            }
        }

        /**
         * Get minimum bundle ID string
         * @return The minimum bundle ID string
         */
        fun getMinBundleId(): String {
            if (BuildConfig.DEBUG) {
                return "00000000-0000-0000-0000-000000000000"
            }
            return BuildConfig.MIN_BUNDLE_ID.takeIf { it != "null" } ?: generateMinBundleIdFromBuildTimestamp()
        }

        /**
         * Generates a bundle ID based on build timestamp
         * @return The generated minimum bundle ID string
         */
        private fun generateMinBundleIdFromBuildTimestamp(): String =
            try {
                val buildTimestampMs = BuildConfig.BUILD_TIMESTAMP
                val bytes =
                    ByteArray(16).apply {
                        this[0] = ((buildTimestampMs shr 40) and 0xFF).toByte()
                        this[1] = ((buildTimestampMs shr 32) and 0xFF).toByte()
                        this[2] = ((buildTimestampMs shr 24) and 0xFF).toByte()
                        this[3] = ((buildTimestampMs shr 16) and 0xFF).toByte()
                        this[4] = ((buildTimestampMs shr 8) and 0xFF).toByte()
                        this[5] = (buildTimestampMs and 0xFF).toByte()
                        this[6] = 0x70.toByte()
                        this[7] = 0x00.toByte()
                        this[8] = 0x80.toByte()
                        this[9] = 0x00.toByte()
                        this[10] = 0x00.toByte()
                        this[11] = 0x00.toByte()
                        this[12] = 0x00.toByte()
                        this[13] = 0x00.toByte()
                        this[14] = 0x00.toByte()
                        this[15] = 0x00.toByte()
                    }
                String.format(
                    "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                    bytes[0].toInt() and 0xFF,
                    bytes[1].toInt() and 0xFF,
                    bytes[2].toInt() and 0xFF,
                    bytes[3].toInt() and 0xFF,
                    bytes[4].toInt() and 0xFF,
                    bytes[5].toInt() and 0xFF,
                    bytes[6].toInt() and 0xFF,
                    bytes[7].toInt() and 0xFF,
                    bytes[8].toInt() and 0xFF,
                    bytes[9].toInt() and 0xFF,
                    bytes[10].toInt() and 0xFF,
                    bytes[11].toInt() and 0xFF,
                    bytes[12].toInt() and 0xFF,
                    bytes[13].toInt() and 0xFF,
                    bytes[14].toInt() and 0xFF,
                    bytes[15].toInt() and 0xFF,
                )
            } catch (e: Exception) {
                "00000000-0000-0000-0000-000000000000"
            }

        /**
         * Gets the current fingerprint hash
         * @param context Application context
         * @return The fingerprint hash or null if not set
         */
        fun getFingerprintHash(context: Context): String? {
            val id = StringResourceUtils.getIdentifier(context, "hot_updater_fingerprint_hash")
            return if (id != 0) {
                context.getString(id).takeIf { it.isNotEmpty() }
            } else {
                null
            }
        }
    }

    /**
     * Gets the current fingerprint hash
     * @return The fingerprint hash or null if not set
     */
    fun getFingerprintHash(): String? {
        val id = StringResourceUtils.getIdentifier(context, "hot_updater_fingerprint_hash")
        return if (id != 0) {
            context.getString(id).takeIf { it.isNotEmpty() }
        } else {
            null
        }
    }

    /**
     * Gets the current update channel
     * @return The channel name or null if not set
     */
    fun getChannel(): String {
        val id = StringResourceUtils.getIdentifier(context, "hot_updater_channel")
        return if (id != 0) {
            context.getString(id).takeIf { it.isNotEmpty() } ?: DEFAULT_CHANNEL
        } else {
            DEFAULT_CHANNEL
        }
    }

    /**
     * Gets the path to the bundle file
     * @return The path to the bundle file
     */
    fun getJSBundleFile(): String = bundleStorage.getBundleURL()

    /**
     * Updates the bundle from the specified URL
     * @param bundleId ID of the bundle to update
     * @param fileUrl URL of the bundle file to download (or null to reset)
     * @param fileHash Combined hash string for verification (sig:<signature> or <hex_hash>)
     * @param progressCallback Callback for download progress updates
     * @throws HotUpdaterException if the update fails
     */
    suspend fun updateBundle(
        bundleId: String,
        fileUrl: String?,
        fileHash: String?,
        progressCallback: (Double) -> Unit,
    ) {
        bundleStorage.updateBundle(bundleId, fileUrl, fileHash, progressCallback)
    }

    /**
     * Reloads the React Native application
     * @param reactContext The original context (preferably ReactApplicationContext to get current activity)
     */
    suspend fun reload(reactContext: Context) {
        val reactIntegrationManager = ReactIntegrationManager(reactContext)
        val bundleURL = getJSBundleFile()

        try {
            withContext(Dispatchers.Main) {
                reactIntegrationManager.setJSBundle(bundleURL)
                reactIntegrationManager.reload()
            }
        } catch (e: Exception) {
            Log.e("HotUpdaterImpl", "Failed to reload application", e)
        }
    }

    /**
     * Notifies the system that the app has successfully started with the given bundle.
     * If the bundle matches the staging bundle, it promotes to stable.
     * @param bundleId The ID of the currently running bundle
     * @return Map containing status and optional crashedBundleId
     */
    fun notifyAppReady(bundleId: String): Map<String, Any?> = bundleStorage.notifyAppReady(bundleId)

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
     * @return Base URL string (e.g., "file:///data/.../bundle-store/abc123/") or empty string
     */
    fun getBaseURL(): String = bundleStorage.getBaseURL()
}
