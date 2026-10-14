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
 * What `HotUpdater.checkForUpdate` and `HotUpdater.prepare` check: the options
 * JavaScript passes to `HotUpdater.init` and `checkForUpdate`.
 */
class HotUpdaterCheckOptions(
    /** The update server's absolute HTTP(S) URL. */
    val baseURL: String,
    val updateStrategy: HotUpdaterUpdateStrategy,
    val requestHeaders: Map<String, String> = emptyMap(),
    /**
     * Checks this channel instead of the current one, as JavaScript's
     * `checkForUpdate({ channel })` does: the switch is saved only once the
     * update is staged, and checking another channel while the runtime channel
     * is already switched is an error until `HotUpdater.resetChannel`.
     */
    val channel: String? = null,
    /**
     * Each request's timeout. In `prepare`, the catalog request also ends at
     * its deadline; the download's requests keep this timeout after it returns.
     */
    val requestTimeoutMillis: Long = 5_000,
)

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
    /** The options the check ran with; `prepare` joins a staging only from an equal request. */
    internal val requestKey: String,
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

/** What `HotUpdater.prepare` found and did. */
sealed class HotUpdaterPrepareResult {
    /** The bundle this launch runs is what the server wants. It may have been downloaded by an earlier launch. */
    object UpToDate : HotUpdaterPrepareResult()

    /** The update was staged before React Native read the bundle, so this launch runs it. */
    data class Ready(
        val update: HotUpdaterUpdate,
    ) : HotUpdaterPrepareResult()

    /**
     * The update applies at the first launch after it is staged: it is still
     * downloading, it is not required and downloads in the background, or
     * React Native had already read the bundle. It runs at this launch only
     * when it is staged before React Native reads the bundle.
     * [HotUpdaterUpdate.shouldForceUpdate] tells a required one.
     */
    data class Pending(
        val update: HotUpdaterUpdate,
    ) : HotUpdaterPrepareResult()

    /** The check or the update failed. [update] is set when the failure came after an update was selected. */
    data class Failed(
        val error: Throwable,
        val update: HotUpdaterUpdate?,
    ) : HotUpdaterPrepareResult()
}
