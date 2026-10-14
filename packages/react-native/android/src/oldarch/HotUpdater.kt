package com.hotupdater

import android.content.Context

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
         * @param params Manifest and asset descriptors for the target bundle
         * @param fileHash Combined hash string for verification (sig:<signature> or <hex_hash>)
         * @param progressCallback Callback for download progress updates
         * @throws HotUpdaterException if the update fails
         */
        suspend fun updateBundle(
            context: Context,
            bundleId: String,
            manifestUrl: String,
            manifestFileHash: String,
            assets: Map<String, ChangedAssetDescriptor>,
            channel: String?,
            archiveUrl: String? = null,
            progressCallback: (UpdateProgressPayload) -> Unit,
        ) {
            getInstance(context).updateBundle(
                bundleId,
                manifestUrl,
                manifestFileHash,
                assets,
                channel,
                archiveUrl = archiveUrl,
                progressCallback = progressCallback,
            )
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
         * Programmatic configuration for brownfield/AAR setups where manifest
         * metadata or string resources in the host app are not desirable.
         * A null argument means no override.
         *
         * [channel] is the app's fixed default channel: it must not change
         * after the first launch, because it is part of the storage isolation
         * key and changing it discards the stored bundles. Switch channels at
         * runtime with [HotUpdaterCheckOptions.channel] and [resetChannel].
         */
        fun configure(
            fingerprintHash: String? = null,
            publicKey: String? = null,
            channel: String? = null,
            isolationKey: String? = null,
        ) {
            HotUpdaterConfig.configure(
                fingerprintHash = fingerprintHash,
                publicKey = publicKey,
                channel = channel,
                isolationKey = isolationKey,
            )
        }

        /**
         * Sets the ReactHost for brownfield apps (Old Architecture - No-op).
         * In old architecture, this is a no-op since ReactHost is not available.
         * @param reactHost The ReactHost instance (accepted as Any for compatibility)
         */
        fun setReactHost(reactHost: Any) {
            // No-op for old architecture
        }

        /**
         * Clears the ReactHost instance (Old Architecture - No-op).
         */
        fun clearReactHost() {
            // No-op for old architecture
        }

        /**
         * Returns to the default channel, as JavaScript's `resetChannel` does,
         * once a check or download running in this process finishes.
         * @return true when the channel was reset
         */
        suspend fun resetChannel(context: Context): Boolean = NativeUpdateCheck.resetChannel(context) { getInstance(context) }

        /**
         * Checks for an update as JavaScript's `checkForUpdate` does, without
         * React Native, for custom flows. Waits for a check or staging already
         * running without a deadline; `prepare` is the bounded entry point.
         * Plugin events are queued for JavaScript to replay.
         * @return the update, or null when there is none
         * @throws Exception when the check fails
         */
        suspend fun checkForUpdate(
            context: Context,
            options: HotUpdaterCheckOptions,
        ): HotUpdaterUpdate? = NativeUpdateCheck.checkForUpdate(context, { getInstance(context) }, options)

        /**
         * Checks for an update and starts it before React Native loads, within
         * one deadline of [timeoutMillis] covering the wait for another check,
         * the requests, and the download of a required update. The deadline and
         * cancellation end the wait, never the download: it continues, applies
         * at the first launch after it is staged, and a later `prepare` or
         * `updateBundle` joins it.
         * An update that is not required downloads in the background without
         * a wait. Never throws: failures are returned, logged, and queued for
         * JavaScript's `onUpdateError`.
         *
         * @param onProgress receives the download progress of a required
         * update as a fraction from 0 to 1, throttled, on any thread, while
         * `prepare` waits for it.
         * @return [HotUpdaterPrepareResult.Ready] only when the update was
         * staged before React Native read the bundle in this process
         */
        suspend fun prepare(
            context: Context,
            options: HotUpdaterCheckOptions,
            timeoutMillis: Long = 3_000,
            onProgress: ((Double) -> Unit)? = null,
        ): HotUpdaterPrepareResult = NativeUpdateCheck.prepare(context, { getInstance(context) }, options, timeoutMillis, onProgress)
    }
}
