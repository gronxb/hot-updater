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
 * `HotUpdater.init`.
 */
class HotUpdaterInstance internal constructor(
    private val context: Context,
    val options: HotUpdaterOptions,
) {
    private val impl: HotUpdaterImpl
        get() = HotUpdater.getInstance(context)

    /**
     * The update the app should apply, or null when there is none. Unlike
     * JavaScript, which returns null and calls `onError`, a failed check
     * throws; it is still reported to plugins as `onUpdateError`. Waits for
     * other native update work; cancelling the caller ends the wait.
     */
    suspend fun checkForUpdate(options: HotUpdaterCheckOptions): HotUpdaterUpdate? =
        NativeUpdateCheck.checkForUpdate(context, { impl }, NativeCheckRequest(this.options, options))

    /**
     * The bundle React Native starts with: the staged update, or the bundle
     * embedded in the app. Reading it fixes this launch's bundle.
     */
    fun getJSBundleFile(): String = impl.getJSBundleFile()

    /**
     * Clears the runtime channel switch and returns to the default channel's
     * bundle at the next launch, once other native update work finishes.
     */
    suspend fun resetChannel(): Boolean = NativeUpdateCheck.resetChannel(context) { impl }

    fun getAppVersion(): String? = HotUpdaterImpl.getAppVersion(context)

    /** The bundle this launch runs, or null for the built-in bundle or before [getJSBundleFile] is read. */
    fun getBundleId(): String? = impl.getBundleId()

    fun getMinBundleId(): String = HotUpdaterImpl.getMinBundleId()

    fun getChannel(): String = impl.getChannel()

    fun getDefaultChannel(): String = impl.getDefaultChannel()

    fun getFingerprintHash(): String? = HotUpdaterImpl.getFingerprintHash(context)
}
