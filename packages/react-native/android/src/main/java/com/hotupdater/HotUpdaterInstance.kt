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
            if (!environment.isMain) HotUpdaterInstanceRegistry.shared.register(environment)
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
    fun getJSBundleFile(): String = impl.getJSBundleFile()

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
}
