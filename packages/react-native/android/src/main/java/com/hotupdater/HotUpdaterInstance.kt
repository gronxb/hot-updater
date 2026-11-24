package com.hotupdater

import android.content.Context

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
     * [checkForUpdate] for the sandbox's explicit channel open: the channel's
     * latest Release this build can run, even one older than the built-in
     * bundle. The same checker and staging as [checkForUpdate].
     */
    internal suspend fun checkForUpdateOlderThanBuiltIn(options: HotUpdaterCheckOptions): HotUpdaterUpdate? =
        NativeUpdateCheck.checkForUpdate(
            context,
            environment.name,
            { impl },
            NativeCheckRequest(this.options, options, allowsOlderThanBuiltIn = true),
        )

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

    /**
     * The ID of the release this launch runs, the ID the Console and
     * JavaScript's `getBundleId()` show: MIN_BUNDLE_ID for the built-in
     * bundle, and the artifact ID only for a bundle installed without a
     * release. Null before [getJSBundleFile] is read. A staged update changes
     * it once it launches, as [getReleaseLabel]; JavaScript's names a staged
     * update right away.
     */
    fun getBundleId(): String? = impl.getRunningReleaseId()

    /**
     * The label of the release this launch runs, shown `v<label>`: null for
     * the built-in bundle, a release without one, or before [getJSBundleFile]
     * is read. Kept with the bundle, so it reads the same after a restart and
     * offline.
     */
    fun getReleaseLabel(): Long? = impl.getRunningReleaseLabel()

    fun getMinBundleId(): String = HotUpdaterImpl.getMinBundleId()

    fun getChannel(): String = impl.getChannel()

    fun getDefaultChannel(): String = impl.getDefaultChannel()

    fun getFingerprintHash(): String? = impl.getFingerprintHash()
}
