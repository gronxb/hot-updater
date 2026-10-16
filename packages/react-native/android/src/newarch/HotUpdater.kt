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
         * runtime with [HotUpdaterCheckOptions.channel] and
         * [HotUpdaterInstance.resetChannel].
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

        /**
         * The native counterpart of JavaScript's `HotUpdater.init`: an
         * instance with this server and these request defaults, for checking
         * for and staging updates before React Native starts.
         * @throws IllegalArgumentException when [HotUpdaterOptions.baseURL] is
         * not an absolute HTTP(S) URL, as `HotUpdater.init` throws, when
         * [HotUpdaterOptions.name] is not 1 to 32 lowercase letters, digits, or
         * hyphens, or when the name was already created with another channel,
         * fingerprint hash, public key, or bundle asset name
         */
        @JvmStatic
        fun init(
            context: Context,
            options: HotUpdaterOptions,
        ): HotUpdaterInstance {
            requireValidBaseURL(options.baseURL)
            return HotUpdaterInstance.create(context.applicationContext, options)
        }

        /**
         * Clears the runtime channel switch once other native update work
         * finishes, as [HotUpdaterInstance.resetChannel] does.
         */
        suspend fun resetChannel(context: Context): Boolean =
            NativeUpdateCheck.resetChannel(context.applicationContext) { getInstance(context) }
    }
}
