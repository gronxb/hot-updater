package com.hotupdater.core

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.hotupdater.BuildConfig
import com.hotupdater.ReactIntegrationManager
import com.hotupdater.services.BundleStorageService
import com.hotupdater.services.PreferencesService

/**
 * Core implementation class for HotUpdater functionality
 */
class HotUpdaterImpl(
    private val context: Context,
    private val bundleStorage: BundleStorageService,
    private val preferences: PreferencesService,
) {
    companion object {
        /**
         * Gets the app version
         * @param context Application context
         * @return App version name or null if not available
         */
        fun getAppVersion(context: Context): String? {
            val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            return packageInfo.versionName
        }

        /**
         * Generates a bundle ID based on build timestamp
         * @return The minimum bundle ID string
         */
        fun getMinBundleId(): String =
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
    }

    /**
     * Sets the update channel
     * @param channel The channel name to set
     */
    fun setChannel(channel: String) {
        preferences.setItem("HotUpdaterChannel", channel)
    }

    /**
     * Gets the current update channel
     * @return The channel name or null if not set
     */
    fun getChannel(): String? = preferences.getItem("HotUpdaterChannel")

    /**
     * Gets the path to the bundle file
     * @return The path to the bundle file
     */
    fun getJSBundleFile(): String = bundleStorage.getBundleURL()

    /**
     * Updates the bundle from the specified URL
     * @param bundleId ID of the bundle to update
     * @param fileUrl URL of the bundle file to download (or null to reset)
     * @param progressCallback Callback for download progress updates
     * @return true if the update was successful
     */
    suspend fun updateBundle(
        bundleId: String,
        fileUrl: String?,
        progressCallback: (Double) -> Unit,
    ): Boolean = bundleStorage.updateBundle(bundleId, fileUrl, progressCallback)

    /**
     * Reloads the React Native application
     * @param activity Current activity (optional)
     */
    fun reload(activity: Activity? = null) {
        val reactIntegrationManager = ReactIntegrationManager(context)
        val application = activity?.application ?: return

        try {
            val reactApplication = reactIntegrationManager.getReactApplication(application)
            val bundleURL = getJSBundleFile()

            reactIntegrationManager.setJSBundle(reactApplication, bundleURL)

            Handler(Looper.getMainLooper()).post {
                reactIntegrationManager.reload(reactApplication)
            }
        } catch (e: Exception) {
            Log.e("HotUpdaterImpl", "Failed to reload application", e)
        }
    }

    /**
     * Gets the current activity from ReactApplicationContext
     * @param context Context that might be a ReactApplicationContext
     * @return The current activity or null
     */
    fun getCurrentActivity(context: Context): Activity? {
        // This would need to be implemented differently or moved
        // since it requires ReactApplicationContext which introduces circular dependencies
        return null
    }
}
