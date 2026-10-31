package com.hotupdater

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * The native counterpart of the instance JavaScript's `HotUpdater.init`
 * returns, for apps that check for and stage updates before React Native
 * starts: [checkForUpdate], the returned update's `updateBundle`,
 * [resetChannel], and the getters, with this instance's server and request
 * defaults. [getJSBundleFile] is the bundle React Native starts with.
 *
 * An update staged before [getJSBundleFile] is read applies at this launch;
 * one staged after it applies at the next launch. Create one with
 * `HotUpdater.init`. Instances with the same [HotUpdaterOptions.name] share
 * one native state; `main` is the one React Native's `HotUpdater` uses.
 */
class HotUpdaterInstance internal constructor(
    private val context: Context,
    val options: HotUpdaterOptions,
    private val environment: HotUpdaterInstanceEnvironment,
) {
    internal companion object {
        /**
         * @throws IllegalArgumentException when the name is invalid, or was
         * already created with another configuration
         */
        fun create(
            context: Context,
            options: HotUpdaterOptions,
        ): HotUpdaterInstance {
            val environment = HotUpdaterInstanceEnvironment.of(options)
            if (environment.isMain) {
                MainInstanceConfiguration.shared.claim(options)
            } else {
                HotUpdaterInstanceRegistry.shared.register(context, environment)
            }
            return HotUpdaterInstance(context, options, environment)
        }
    }

    private val impl: HotUpdaterImpl
        get() =
            if (environment.isMain) {
                HotUpdater.getInstance(context)
            } else {
                HotUpdaterInstanceRegistry.shared.impl(context, environment)
            }

    /**
     * The update the app should apply, or null when there is none. Unlike
     * JavaScript, which returns null and calls `onError`, a failed check
     * throws; it is still reported to plugins as `onUpdateError`. Waits for
     * other native update work; cancelling the caller ends the wait.
     */
    suspend fun checkForUpdate(options: HotUpdaterCheckOptions): HotUpdaterUpdate? =
        NativeUpdateCheck.checkForUpdate(context, environment.name, { impl }, NativeCheckRequest(this.options, options))

    /**
     * The bundle React Native starts with: the staged update, or the bundle
     * embedded in the app. Reading it fixes this launch's bundle.
     */
    fun getJSBundleFile(): String =
        if (environment.isMain) {
            impl.getJSBundleFile()
        } else {
            HotUpdaterInstanceRegistry.shared.launchURL(context, environment)
        }

    /**
     * Clears the runtime channel switch and returns to the default channel's
     * bundle at the next launch, once other native update work finishes.
     */
    suspend fun resetChannel(): Boolean = NativeUpdateCheck.resetChannel(context, environment.name) { impl }

    fun getAppVersion(): String? = HotUpdaterImpl.getAppVersion(context)

    /** The bundle this launch runs, or null for the built-in bundle or before [getJSBundleFile] is read. */
    fun getBundleId(): String? = impl.getRunningBundleId()

    fun getMinBundleId(): String = HotUpdaterImpl.getMinBundleId()

    fun getChannel(): String = impl.getChannel()

    fun getDefaultChannel(): String = impl.getDefaultChannel()

    fun getFingerprintHash(): String? = impl.getFingerprintHash()

    /**
     * Reads whether a check can run, whether the next launch runs another
     * bundle, and the running bundle, channel, app version, fingerprint, and
     * minimum bundle ID, as JavaScript's `getUpdateStatus` does. Reads files,
     * so call it off the main thread.
     */
    fun getUpdateStatus(): HotUpdaterUpdateStatusSnapshot {
        val bundles = impl.getUpdateStatus()
        val appVersion = getAppVersion()
        return HotUpdaterUpdateStatusSnapshot(
            isEnabled = !appVersion.isNullOrEmpty(),
            isUpdatePending = bundles.pendingBundleId != null,
            pendingBundleId = bundles.pendingBundleId,
            bundleId = bundles.bundleId,
            channel = getChannel(),
            appVersion = appVersion,
            fingerprintHash = getFingerprintHash(),
            minBundleId = getMinBundleId(),
        )
    }

    /**
     * This instance's update log, newest first, as JavaScript's `getUpdateLogs`
     * returns it: the entries at most [maxAgeMillis] old, then the newest
     * [limit] of them. Reads a file, so call it off the main thread.
     */
    fun getUpdateLogs(
        maxAgeMillis: Long? = null,
        limit: Int? = null,
    ): List<HotUpdaterUpdateLogEntry> {
        val oldest = maxAgeMillis?.let { System.currentTimeMillis() - it }
        val entries = JSONArray(impl.getUpdateLogsJson())
        return (entries.length() - 1 downTo 0)
            .mapNotNull { entries.optJSONObject(it)?.let(HotUpdaterUpdateLogEntry::of) }
            .filter { oldest == null || it.timestamp >= oldest }
            .let { if (limit == null) it else it.take(limit.coerceAtLeast(0)) }
    }

    /** Deletes this instance's update log. Waits for its writes, so call it off the main thread. */
    fun clearUpdateLogs(): Boolean = impl.clearUpdateLogs()
}

/** What [HotUpdaterInstance.getUpdateStatus] reads. */
data class HotUpdaterUpdateStatusSnapshot(
    /** Whether a check can run: native checks need the app's version. */
    val isEnabled: Boolean,
    /**
     * Whether the next launch runs another bundle than this one: a downloaded
     * update, or the built-in bundle after a rollback or a channel reset. Before
     * [HotUpdaterInstance.getJSBundleFile] is read, a staged update counts.
     */
    val isUpdatePending: Boolean,
    /** The bundle the next launch runs, when it is not this one. */
    val pendingBundleId: String?,
    /** The bundle running now, which a staged update does not change. */
    val bundleId: String,
    val channel: String,
    val appVersion: String?,
    val fingerprintHash: String?,
    val minBundleId: String,
)

/** One update event [HotUpdaterInstance.getUpdateLogs] reads, with JavaScript's `UpdateLogEntry` values. */
data class HotUpdaterUpdateLogEntry(
    /** When it happened, in milliseconds since the epoch. */
    val timestamp: Long,
    /** CHECK, DOWNLOAD, APPLY, ROLLBACK, or CRASH_RECOVERY. */
    val type: String,
    /** What came of it, such as STAGED or ROLLED_BACK_AFTER_CRASH. */
    val outcome: String,
    val bundleId: String?,
    val fromBundleId: String?,
    val releaseId: String?,
    val channel: String?,
    val errorCode: String?,
    /** The error's message, with every URL cut down to its host. */
    val errorMessage: String?,
) {
    internal companion object {
        fun of(entry: JSONObject): HotUpdaterUpdateLogEntry? {
            val type = entry.optString("type").takeIf { it.isNotEmpty() } ?: return null
            val outcome = entry.optString("outcome").takeIf { it.isNotEmpty() } ?: return null
            val error = entry.optJSONObject("error")
            return HotUpdaterUpdateLogEntry(
                timestamp = entry.optLong("timestamp"),
                type = type,
                outcome = outcome,
                bundleId = entry.nonEmptyString("bundleId"),
                fromBundleId = entry.nonEmptyString("fromBundleId"),
                releaseId = entry.nonEmptyString("releaseId"),
                channel = entry.nonEmptyString("channel"),
                errorCode = error?.nonEmptyString("code"),
                errorMessage = error?.nonEmptyString("message"),
            )
        }

        private fun JSONObject.nonEmptyString(key: String): String? = if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }
    }
}
