package com.hotupdater

import android.content.Context
import java.io.File

/**
 * Where an instance keeps its native state and which configuration it reads,
 * chosen by [HotUpdaterOptions.name].
 *
 * `main` is the state React Native's `HotUpdater`, the TurboModule, and the
 * static entry points use: every path Hot Updater has always used, and the
 * configuration its [HotUpdaterOptions] and the deprecated
 * `HotUpdater.configure` record in [HotUpdaterConfig] before the manifest. Any
 * other name keeps its state beside main's, never inside `bundle-store`, whose
 * sweeps delete entries they don't know, and reads its configuration from its
 * [HotUpdaterOptions] and then the manifest, never from [HotUpdaterConfig].
 * The install id and the cohort belong to the device and stay shared.
 */
internal class HotUpdaterInstanceEnvironment private constructor(
    val name: String,
    private val channel: String?,
    private val fingerprintHash: String?,
    private val publicKey: String?,
    private val bundleAssetName: String,
    // Main's impl: the values it was created with, which it reads instead of
    // HotUpdaterConfig. Null for main's static entry points, which read
    // HotUpdaterConfig, and for named instances.
    private val mainValues: MainImplValues? = null,
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

        /** Beside `bundle-store` in the app's files directory: one directory per named instance. */
        const val INSTANCES_DIRECTORY = "hot-updater-instances"
        private const val INSTANCES_NO_BACKUP_DIRECTORY = "instances"
        private const val RELEASE_CATALOG_CACHE_DIRECTORY = "release-catalog-cache"
        private val NAME_PATTERN = Regex("^[a-z0-9-]{1,32}$")

        val main = HotUpdaterInstanceEnvironment(MAIN_NAME, null, null, null, DEFAULT_BUNDLE_ASSET_NAME)

        /** Main, fixed to [values]: what main's impl reads, so a later write to HotUpdaterConfig never reaches it. */
        fun main(values: MainImplValues) = HotUpdaterInstanceEnvironment(MAIN_NAME, null, null, null, DEFAULT_BUNDLE_ASSET_NAME, values)

        /**
         * The environment of [options]. `main`'s configuration lives in
         * [HotUpdaterConfig], where `HotUpdater.init` records its options.
         * @throws IllegalArgumentException when the name is not 1 to 32
         * lowercase letters, digits, or hyphens, or when `main` names a
         * bundle asset other than its own
         */
        fun of(options: HotUpdaterOptions): HotUpdaterInstanceEnvironment {
            require(NAME_PATTERN.matches(options.name)) {
                "HotUpdater instance name must be 1 to 32 lowercase letters, digits, or hyphens: \"${options.name}\""
            }
            if (options.name == MAIN_NAME) {
                // React Native's own HotUpdater starts main from this asset.
                require(options.bundleAssetName == DEFAULT_BUNDLE_ASSET_NAME) {
                    "HotUpdater instance \"main\" launches $DEFAULT_BUNDLE_ASSET_NAME, not \"${options.bundleAssetName}\""
                }
                return main
            }
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

    /** The instance's update log, beside its key-value store and outside `bundle-store`, whose sweeps delete it. */
    fun updateLogFile(context: Context): File = File(keyValueStorageFile(context).parentFile, UpdateLogService.FILENAME)

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
     *
     * With a fingerprint, the key is the fingerprint, the build's
     * [minBundleId], and the channel: a host release that ships the same
     * artifact keeps its downloads, while a new build, whose embedded bundle
     * is newer, starts from it. Without one, the app version takes the
     * fingerprint's and the build's place, as the appVersion strategy's
     * releases are keyed by it.
     */
    fun isolationKey(
        context: Context,
        minBundleId: String = HotUpdaterImpl.getMinBundleId(),
    ): String {
        if (isMain) {
            // The deprecated HotUpdater.configure(isolationKey:) override is
            // used verbatim. It is main's own key, so a named instance never
            // uses it.
            val override = if (mainValues != null) mainValues.isolationKey else HotUpdaterConfig.isolationKey
            override?.takeIf { it.isNotEmpty() }?.let { return it }
        }

        val fingerprintHash = fingerprintHash(context)
        val appChannel = defaultChannel(context)
        val baseKey =
            if (!fingerprintHash.isNullOrEmpty()) {
                "${fingerprintHash}_$minBundleId"
            } else {
                HotUpdaterImpl.getAppVersion(context) ?: "unknown"
            }

        return "$preferencesPrefix${baseKey}_$appChannel"
    }

    /** The channel the instance's build ships with, before any runtime switch. */
    fun defaultChannel(context: Context): String =
        if (isMain) {
            mainValues?.channel ?: HotUpdaterImpl.getChannel(context)
        } else {
            channel
                ?: NativeConfigUtils.getManifestString(context, NativeConfigUtils.CHANNEL_META_DATA_KEY)
                ?: HotUpdaterImpl.DEFAULT_CHANNEL
        }

    fun fingerprintHash(context: Context): String? =
        if (isMain) {
            if (mainValues != null) mainValues.fingerprintHash else HotUpdaterImpl.getFingerprintHash(context)
        } else {
            // Every instance's bundle comes from the project the build
            // fingerprinted.
            fingerprintHash ?: HotUpdaterConfig.buildFingerprintHash
        }

    /** The PEM key bundles must be signed with, or null when signing is off. */
    fun publicKey(context: Context): String? =
        if (isMain) {
            if (mainValues != null) mainValues.publicKey else SignatureVerifier.getPublicKeyFromConfig(context)
        } else {
            publicKey ?: NativeConfigUtils.getManifestString(context, NativeConfigUtils.PUBLIC_KEY_META_DATA_KEY)
        }

    /** The JavaScript bundle embedded in the app that the instance launches without an update. */
    val fallbackBundleURL: String
        get() = "assets://$bundleAssetName"

    /**
     * Whether [other] resolves to the same configuration, so both can share
     * this name's state: an option left out and one that names the value the
     * manifest or the default gives are the same.
     */
    fun hasSameConfiguration(
        other: HotUpdaterInstanceEnvironment,
        context: Context,
    ): Boolean =
        name == other.name &&
            defaultChannel(context) == other.defaultChannel(context) &&
            fingerprintHash(context) == other.fingerprintHash(context) &&
            publicKey(context) == other.publicKey(context) &&
            bundleAssetName == other.bundleAssetName

    private fun noBackupRoot(context: Context): File = File(NoBackupStorage.file(context, INSTANCES_NO_BACKUP_DIRECTORY), name)
}

/**
 * The one [HotUpdaterImpl] of each named instance, so instances with the same
 * name share state, and the launch URLs they handed out, which tell each
 * React Native runtime's TurboModule which instance it serves. Main's impl is
 * `HotUpdater.getInstance`, which every static entry point uses.
 */
internal class HotUpdaterInstanceRegistry(
    private val create: (Context, HotUpdaterInstanceEnvironment) -> HotUpdaterImpl,
) {
    companion object {
        val shared = HotUpdaterInstanceRegistry { context, environment -> HotUpdaterImpl(context, environment) }
    }

    private val environments = HashMap<String, HotUpdaterInstanceEnvironment>()
    private val impls = HashMap<String, HotUpdaterImpl>()

    // The last launch URL each name handed out, which the runtime that loads
    // it reports back as its source URL.

    /** Every launch URL each name handed out: a runtime may still run an earlier one. */
    private val launchURLs = HashMap<String, MutableSet<String>>()

    /**
     * Records the configuration of [environment]'s name. A name reads one
     * configuration, since its stored bundles were verified and keyed with it.
     * @throws IllegalArgumentException when the name was registered with another
     */
    @Synchronized
    fun register(
        context: Context,
        environment: HotUpdaterInstanceEnvironment,
    ) {
        require(!environment.isMain) { "main's state belongs to HotUpdater.getInstance" }
        val registered = environments.getOrPut(environment.name) { environment }
        require(registered.hasSameConfiguration(environment, context)) {
            "HotUpdater instance \"${environment.name}\" was already created with another channel, " +
                "fingerprintHash, publicKey, or bundleAssetName"
        }
    }

    @Synchronized
    fun impl(
        context: Context,
        environment: HotUpdaterInstanceEnvironment,
    ): HotUpdaterImpl {
        register(context, environment)
        return impls.getOrPut(environment.name) { create(context, environment) }
    }

    /** The impl of [name], or null when no named instance of it has one yet. */
    @Synchronized
    fun impl(name: String): HotUpdaterImpl? = impls[name]

    /**
     * The bundle a React Native host of [environment] starts with, recorded
     * so the TurboModule of the runtime that loads it finds this instance.
     */
    fun launchURL(
        context: Context,
        environment: HotUpdaterInstanceEnvironment,
    ): String {
        // Reading it prepares the launch, which reads storage, so it runs
        // outside the registry's lock.
        val url = impl(context, environment).getJSBundleFile()
        synchronized(this) { launchURLs.getOrPut(environment.name) { mutableSetOf() }.add(url) }
        return url
    }

    /**
     * The name of the instance whose bundle a React Native runtime runs, from
     * the URL the runtime loaded it from: the launch URL a named instance
     * handed out, then a file inside a named instance's storage (a bundle it
     * staged, loaded after a reload), then main, which covers main's own
     * bundles, the development server, and URLs no instance knows. Only
     * names with an impl are candidates.
     */
    @Synchronized
    fun resolveName(
        context: Context,
        sourceURL: String?,
    ): String {
        // Crash recovery asks for every view it checks; without a named
        // instance, main's answer needs no path work.
        if (sourceURL.isNullOrEmpty() || impls.isEmpty()) return HotUpdaterInstanceEnvironment.MAIN_NAME

        // Two names that hand out the same URL, such as the same embedded
        // bundle, can't be told apart by it.
        launchURLs
            .filter { (name, urls) -> sourceURL in urls && name in impls }
            .keys
            .singleOrNull()
            ?.let { return it }

        val sourceSegments = pathSegments(canonicalPath(sourceURL.removePrefix("file://")))
        impls.keys
            .firstOrNull { name ->
                val root = environments[name]?.filesRoot(context) ?: return@firstOrNull false
                val rootSegments = pathSegments(canonicalPath(root.path))
                // Whole segments, so "app" never claims "app-2"'s files.
                sourceSegments.size > rootSegments.size && sourceSegments.subList(0, rootSegments.size) == rootSegments
            }?.let { return it }

        return HotUpdaterInstanceEnvironment.MAIN_NAME
    }

    // React Native may hold `/data/data/...` where `filesDir` is
    // `/data/user/0/...`, a symlink to the same directory.
    private fun canonicalPath(path: String): String =
        if (path.startsWith("/")) runCatching { File(path).canonicalPath }.getOrDefault(path) else path

    private fun pathSegments(path: String): List<String> {
        if (!path.startsWith("/")) return emptyList()
        val segments = ArrayList<String>()
        path.split('/').forEach { segment ->
            when (segment) {
                "", "." -> Unit
                ".." -> if (segments.isNotEmpty()) segments.removeAt(segments.size - 1)
                else -> segments += segment
            }
        }
        return segments
    }
}
