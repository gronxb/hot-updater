package com.hotupdater

import android.content.Context
import java.io.File

/**
 * Where an instance keeps its native state and which configuration it reads,
 * chosen by [HotUpdaterOptions.name].
 *
 * `main` is the state React Native's `HotUpdater`, the TurboModule, and the
 * static entry points use: every path, key, and configuration read is the one
 * Hot Updater has always used. Any other name keeps its state beside main's,
 * never inside `bundle-store`, whose sweeps delete entries they don't know,
 * and reads its configuration from [HotUpdaterOptions] before the manifest.
 * The install id and the cohort belong to the device and stay shared.
 */
internal class HotUpdaterInstanceEnvironment private constructor(
    val name: String,
    private val channel: String?,
    private val fingerprintHash: String?,
    private val publicKey: String?,
    private val bundleAssetName: String,
) {
    companion object {
        const val MAIN_NAME = "main"
        const val DEFAULT_BUNDLE_ASSET_NAME = "index.android.bundle"

        /** The family every main isolation key is in, whatever its version and channel. */
        const val MAIN_PREFERENCES_PREFIX = "HotUpdaterPrefs_"

        // Main's sweep deletes every other HotUpdaterPrefs_ file, so named
        // families must not start with it. Names have no underscore, so one
        // name's family is never a prefix of another's.
        private const val INSTANCE_PREFERENCES_PREFIX = "HotUpdaterInstancePrefs_"
        private const val INSTANCES_DIRECTORY = "hot-updater-instances"
        private const val INSTANCES_NO_BACKUP_DIRECTORY = "instances"
        private const val RELEASE_CATALOG_CACHE_DIRECTORY = "release-catalog-cache"
        private val NAME_PATTERN = Regex("^[a-z0-9-]{1,32}$")

        val main = HotUpdaterInstanceEnvironment(MAIN_NAME, null, null, null, DEFAULT_BUNDLE_ASSET_NAME)

        /**
         * The environment of [options]. `main` ignores the options' configuration
         * and reads the manifest and `HotUpdater.configure`, as it always has.
         * @throws IllegalArgumentException when the name is not 1 to 32
         * lowercase letters, digits, or hyphens
         */
        fun of(options: HotUpdaterOptions): HotUpdaterInstanceEnvironment {
            require(NAME_PATTERN.matches(options.name)) {
                "HotUpdater instance name must be 1 to 32 lowercase letters, digits, or hyphens: \"${options.name}\""
            }
            if (options.name == MAIN_NAME) return main
            // Main's runtime is told apart by the bundle it runs, so a named
            // instance embeds a bundle of its own.
            require(options.bundleAssetName != DEFAULT_BUNDLE_ASSET_NAME) {
                "A named HotUpdater instance needs its own bundleAssetName, not $DEFAULT_BUNDLE_ASSET_NAME: \"${options.name}\""
            }
            return HotUpdaterInstanceEnvironment(
                name = options.name,
                channel = options.channel?.takeIf { it.isNotEmpty() },
                fingerprintHash = options.fingerprintHash?.takeIf { it.isNotEmpty() },
                publicKey = options.publicKey?.takeIf { it.isNotEmpty() },
                bundleAssetName = options.bundleAssetName,
            )
        }
    }

    val isMain: Boolean
        get() = name == MAIN_NAME

    /** The directory that holds `bundle-store` and `bundle-manifest-temp`. */
    fun filesRoot(context: Context): File? =
        if (isMain) {
            context.filesDir
        } else {
            context.filesDir?.let { File(File(it, INSTANCES_DIRECTORY), name) }
        }

    /** The client plugins' key-value store, which also holds the native update event queue. */
    fun keyValueStorageFile(context: Context): File =
        if (isMain) {
            NoBackupStorage.file(context, KeyValueStorageService.FILENAME)
        } else {
            File(noBackupRoot(context), KeyValueStorageService.FILENAME)
        }

    /** Each directory trims to its own entries, so one instance never evicts another's. */
    fun releaseCatalogCacheDirectory(context: Context): File =
        if (isMain) {
            File(context.noBackupFilesDir, "hot-updater-release-catalog-cache")
        } else {
            File(noBackupRoot(context), RELEASE_CATALOG_CACHE_DIRECTORY)
        }

    /** The prefix of every isolation key of this instance, which its preferences sweep owns. */
    val preferencesPrefix: String
        get() = if (isMain) MAIN_PREFERENCES_PREFIX else "$INSTANCE_PREFERENCES_PREFIX${name}_"

    /**
     * The key that names this instance's preferences and stamps its bundle
     * metadata; a new key discards the stored bundles.
     */
    fun isolationKey(context: Context): String {
        if (isMain) {
            // Programmatic override (brownfield/AAR). When set, it is used verbatim
            // so the OTA cache can stay stable across host app version bumps.
            // It is main's own key, so a named instance never uses it.
            HotUpdaterConfig.isolationKey?.takeIf { it.isNotEmpty() }?.let { return it }
        }

        val fingerprintHash = fingerprintHash(context)

        // Get app version and channel
        val appVersion = HotUpdaterImpl.getAppVersion(context) ?: "unknown"
        val appChannel = defaultChannel(context)

        // Include both fingerprint hash and app version for complete isolation
        val baseKey =
            if (!fingerprintHash.isNullOrEmpty()) {
                "${fingerprintHash}_$appVersion"
            } else {
                appVersion
            }

        return "$preferencesPrefix${baseKey}_$appChannel"
    }

    /** The channel the instance's build ships with, before any runtime switch. */
    fun defaultChannel(context: Context): String = channel ?: HotUpdaterImpl.getChannel(context)

    fun fingerprintHash(context: Context): String? = fingerprintHash ?: HotUpdaterImpl.getFingerprintHash(context)

    /** The PEM key bundles must be signed with, or null when signing is off. */
    fun publicKey(context: Context): String? = publicKey ?: SignatureVerifier.getPublicKeyFromConfig(context)

    /** The JavaScript bundle embedded in the app that the instance launches without an update. */
    val fallbackBundleURL: String
        get() = "assets://$bundleAssetName"

    /** Whether [other] reads the same configuration, so both can share this name's state. */
    fun hasSameConfiguration(other: HotUpdaterInstanceEnvironment): Boolean =
        name == other.name &&
            channel == other.channel &&
            fingerprintHash == other.fingerprintHash &&
            publicKey == other.publicKey &&
            bundleAssetName == other.bundleAssetName

    private fun noBackupRoot(context: Context): File = File(NoBackupStorage.file(context, INSTANCES_NO_BACKUP_DIRECTORY), name)
}

/**
 * The one [HotUpdaterImpl] of each named instance, so instances with the same
 * name share state. Main's is `HotUpdater.getInstance`, which every static
 * entry point and the TurboModule already use.
 */
internal class HotUpdaterInstanceRegistry(
    private val create: (Context, HotUpdaterInstanceEnvironment) -> HotUpdaterImpl,
) {
    companion object {
        val shared = HotUpdaterInstanceRegistry { context, environment -> HotUpdaterImpl(context, environment) }
    }

    private val environments = HashMap<String, HotUpdaterInstanceEnvironment>()
    private val impls = HashMap<String, HotUpdaterImpl>()

    /**
     * Records the configuration of [environment]'s name. A name reads one
     * configuration, since its stored bundles were verified and keyed with it.
     * @throws IllegalArgumentException when the name was registered with another
     */
    @Synchronized
    fun register(environment: HotUpdaterInstanceEnvironment) {
        require(!environment.isMain) { "main's state belongs to HotUpdater.getInstance" }
        val registered = environments.getOrPut(environment.name) { environment }
        require(registered.hasSameConfiguration(environment)) {
            "HotUpdater instance \"${environment.name}\" was already created with another channel, " +
                "fingerprintHash, publicKey, or bundleAssetName"
        }
    }

    @Synchronized
    fun impl(
        context: Context,
        environment: HotUpdaterInstanceEnvironment,
    ): HotUpdaterImpl {
        register(environment)
        return impls.getOrPut(environment.name) { create(context, environment) }
    }
}
