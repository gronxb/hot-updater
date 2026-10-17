package com.hotupdater

import android.app.Activity
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
                instance ?: MainInstanceConfiguration
                    .createImpl(context.applicationContext) {
                        // From here on, main's options can no longer change
                        // what the impl reads.
                        HotUpdaterImpl(context.applicationContext)
                    }.also {
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
         * Main's configuration, which [HotUpdaterOptions] of [init] now set.
         * Each call replaces all four values; a null argument means no
         * override. [isolationKey] replaces main's storage key verbatim.
         * Named instances never read these values.
         */
        @Deprecated(
            "Pass channel, fingerprintHash, and publicKey to HotUpdaterOptions. " +
                "Fingerprint downloads now survive native releases that ship the same artifact.",
            ReplaceWith(
                "HotUpdater.init(context, HotUpdaterOptions(baseURL, channel = channel, " +
                    "fingerprintHash = fingerprintHash, publicKey = publicKey))",
            ),
        )
        @JvmStatic
        @Suppress("DEPRECATION")
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
         * The native counterpart of JavaScript's `HotUpdater.init`: an
         * instance with this server and these request defaults, for checking
         * for and staging updates before React Native starts.
         * @throws IllegalArgumentException when [HotUpdaterOptions.baseURL] is
         * not an absolute HTTP(S) URL, as `HotUpdater.init` throws, when
         * [HotUpdaterOptions.name] is not 1 to 32 lowercase letters, digits, or
         * hyphens, or when the name was already created with another channel,
         * fingerprint hash, public key, or bundle asset name. `main` refuses
         * a bundle asset name other than `index.android.bundle`, and a
         * channel, fingerprint hash, or public key other than the one an
         * earlier `init` or `HotUpdater.configure` set or, once its native
         * state was first read, the one it uses
         */
        @JvmStatic
        fun init(
            context: Context,
            options: HotUpdaterOptions,
        ): HotUpdaterInstance {
            requireValidBaseURL(options.baseURL)
            // An activity started before this process followed activities is
            // known only from the context the app hands over.
            (context as? Activity)?.let(HotUpdaterRecoveryAttribution.shared::noteActivity)
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
