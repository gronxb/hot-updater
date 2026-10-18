package com.hotupdater

/** Which Release catalog an update check reads: the app version's or the fingerprint's. */
enum class HotUpdaterUpdateStrategy(
    internal val value: String,
    internal val releaseStrategy: ReleaseStrategy,
) {
    APP_VERSION("appVersion", ReleaseStrategy.APP_VERSION),
    FINGERPRINT("fingerprint", ReleaseStrategy.FINGERPRINT),
}

/** Whether an update moves the app forward or rolls it back. */
enum class HotUpdaterUpdateStatus {
    UPDATE,
    ROLLBACK,
}

/**
 * The values JavaScript passes to `HotUpdater.init`: the server and the
 * request defaults of a [HotUpdaterInstance], plus the native state it uses.
 * `main` records [channel], [fingerprintHash], and [publicKey] before its
 * native state is first read; a value left null keeps one the deprecated
 * `HotUpdater.configure` set.
 */
class HotUpdaterOptions
    @JvmOverloads
    constructor(
        /** The update server's absolute HTTP(S) URL. */
        val baseURL: String,
        /** Sent with every request; a check's own headers override them. */
        val requestHeaders: Map<String, String> = emptyMap(),
        /** Each request's timeout, unless a check sets its own. */
        val requestTimeoutMillis: Long = 5_000,
        /**
         * Which native state the instance uses, like a Firebase app name: `main`,
         * the default, is the state React Native's own `HotUpdater` uses. Any other
         * name keeps its bundles, settings, and stored values apart from every
         * other name's; instances with the same name share them. 1 to 32
         * lowercase letters, digits, or hyphens.
         */
        val name: String = HotUpdaterInstanceEnvironment.MAIN_NAME,
        /**
         * The default channel the instance's build ships with, before any
         * runtime switch; null reads the manifest's `com.hotupdater.CHANNEL`,
         * then `production`. It is part of the storage key, so it must not
         * change after the first launch: switch channels at runtime with
         * [HotUpdaterCheckOptions.channel] and [HotUpdaterInstance.resetChannel].
         * An instance of a name refuses a channel other than the one the name
         * already uses.
         */
        val channel: String? = null,
        /**
         * The fingerprint hash of the fingerprint strategy; null reads the
         * manifest's `com.hotupdater.FINGERPRINT_HASH`, and without one the
         * instance uses the appVersion strategy's storage key.
         */
        val fingerprintHash: String? = null,
        /**
         * The PEM public key bundles must be signed with; null reads the
         * manifest's `com.hotupdater.PUBLIC_KEY`, and without one signing is off.
         */
        val publicKey: String? = null,
        /**
         * The JavaScript bundle embedded in the app's assets that a named instance
         * launches when it has no update. Assets of every library merge into the
         * app's, so each named instance embeds its bundle under its own name.
         * `main` launches `index.android.bundle` and refuses any other name.
         */
        val bundleAssetName: String = HotUpdaterInstanceEnvironment.DEFAULT_BUNDLE_ASSET_NAME,
    )

/** The values JavaScript passes to `checkForUpdate`. */
class HotUpdaterCheckOptions(
    val updateStrategy: HotUpdaterUpdateStrategy,
    /**
     * Checks this channel instead of the current one, as JavaScript's
     * `checkForUpdate({ channel })` does: the switch is saved only once the
     * update is staged, and checking another channel while the runtime channel
     * is already switched is an error until [HotUpdaterInstance.resetChannel].
     */
    val channel: String? = null,
    /** Merged over the instance's headers; these win. */
    val requestHeaders: Map<String, String> = emptyMap(),
    /** Each request's timeout; null uses the instance's. */
    val requestTimeoutMillis: Long? = null,
)

/**
 * One check's settings: the instance's, with the check's own over them, as
 * JavaScript's `checkForUpdate` merges them.
 */
internal class NativeCheckRequest(
    val baseURL: String,
    val updateStrategy: HotUpdaterUpdateStrategy,
    val requestHeaders: Map<String, String> = emptyMap(),
    val channel: String? = null,
    val requestTimeoutMillis: Long = 5_000,
) {
    constructor(instance: HotUpdaterOptions, check: HotUpdaterCheckOptions) : this(
        baseURL = instance.baseURL,
        updateStrategy = check.updateStrategy,
        requestHeaders =
            LinkedHashMap(instance.requestHeaders).apply {
                // Header names are case-insensitive: the check's spelling replaces the instance's.
                check.requestHeaders.forEach { (name, value) ->
                    keys.removeAll { it.equals(name, ignoreCase = true) }
                    put(name, value)
                }
            },
        channel = check.channel,
        requestTimeoutMillis = check.requestTimeoutMillis ?: instance.requestTimeoutMillis,
    )
}

/**
 * The update a check found, with the fields of JavaScript's
 * `CheckForUpdateResult`.
 */
class HotUpdaterUpdate internal constructor(
    /** [releaseId], or the bundle ID when the update names no Release. */
    val id: String,
    val releaseId: String?,
    val status: HotUpdaterUpdateStatus,
    /** A required update: the device should not keep running its current bundle. */
    val shouldForceUpdate: Boolean,
    val message: String?,
    /** How many of the 1000 rollout cohorts receive the Release. */
    val rolloutCohortCount: Int,
    /** Cohorts that receive the Release whatever [rolloutCohortCount] says. */
    val targetCohorts: List<String>,
    /** `INSTALL`, `ADOPT_RELEASE`, or `USE_BUILTIN`. */
    val transitionKind: String,
    /** The update selects the bundle the app already launches, so staging it only records the selection. */
    internal val runsCurrentBundle: Boolean,
    /** What staging this update produces; a staging already running for it is joined. */
    internal val targetKey: String,
    private val install: suspend (((Double) -> Unit)?) -> Boolean,
) {
    /**
     * Downloads and stages the update for the next launch, or commits a
     * selection that needs no download, and joins a staging already running
     * for it. Waits without a deadline; cancelling the caller ends the wait,
     * not the download. Returns false when the selection was superseded.
     *
     * @param onProgress receives the progress as a fraction from 0 to 1,
     * throttled, on any thread.
     */
    suspend fun updateBundle(onProgress: ((Double) -> Unit)? = null): Boolean = install(onProgress)
}
