package com.hotupdater

import android.content.Context
import com.facebook.react.ReactHost

/**
 * Main React Native package for HotUpdater
 * Provides static utility methods and a default singleton instance
 */
class HotUpdater {
    companion object {
        @Volatile
        private var instance: HotUpdaterImpl? = null

        /**
         * Gets or creates the singleton instance
         * Thread-safe double-checked locking
         * @param context Application context
         * @return The singleton HotUpdaterImpl instance
         */
        fun getInstance(context: Context): HotUpdaterImpl =
            instance ?: synchronized(this) {
                instance ?: HotUpdaterImpl(context.applicationContext).also {
                    instance = it
                }
            }

        /**
         * Gets the JS bundle file path using the default singleton instance
         * @param context Application context
         * @return The path to the bundle file
         */
        fun getJSBundleFile(context: Context): String = getInstance(context).getJSBundleFile()

        /**
         * Updates the bundle using the default singleton instance
         * @param context Application context
         * @param bundleId ID of the bundle to update
         * @param fileUrl URL of the bundle file to download (or null to reset)
         * @param fileHash Combined hash string for verification (sig:<signature> or <hex_hash>)
         * @param progressCallback Callback for download progress updates
         * @throws HotUpdaterException if the update fails
         */
        suspend fun updateBundle(
            context: Context,
            bundleId: String,
            fileUrl: String?,
            fileHash: String?,
            progressCallback: (Double) -> Unit,
        ) {
            getInstance(context).updateBundle(bundleId, fileUrl, fileHash, progressCallback)
        }

        /**
         * Reloads the React Native application using the default singleton instance
         * @param context Context (preferably ReactApplicationContext)
         */
        suspend fun reload(context: Context) {
            getInstance(context).reload(context)
        }

        /**
         * Gets the app version - delegates to HotUpdaterImpl static method
         * @param context Application context
         * @return App version name or null if not available
         */
        fun getAppVersion(context: Context): String? = HotUpdaterImpl.getAppVersion(context)

        /**
         * Gets the minimum bundle ID - delegates to HotUpdaterImpl static method
         * @return The minimum bundle ID string
         */
        fun getMinBundleId(): String = HotUpdaterImpl.getMinBundleId()

        /**
         * Gets the current fingerprint hash - delegates to HotUpdaterImpl static method
         * @param context Application context
         * @return The fingerprint hash or null if not set
         */
        fun getFingerprintHash(context: Context): String? = HotUpdaterImpl.getFingerprintHash(context)

        /**
         * Gets the current update channel - delegates to HotUpdaterImpl static method
         * @param context Application context
         * @return The channel name or null if not set
         */
        fun getChannel(context: Context): String = HotUpdaterImpl.getChannel(context)

        /**
         * Sets the ReactHost for brownfield apps (New Architecture).
         * Sets the ReactHost for brownfield apps that don't have ReactApplication.
         * When set, reload() will use this ReactHost instead of accessing Application.
         * @param reactHost The ReactHost instance
         */
        fun setReactHost(reactHost: ReactHost) {
            ReactHostHolder.setReactHost(reactHost)
        }

        /**
         * Clears the ReactHost instance (New Architecture).
         */
        fun clearReactHost() {
            ReactHostHolder.clear()
        }
    }
}
