package com.hotupdater

import android.app.Activity
import android.content.Context
import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

/**
 * Main React Native package for HotUpdater
 */
class HotUpdater : ReactPackage {
    override fun createViewManagers(context: ReactApplicationContext): MutableList<ViewManager<View, ReactShadowNode<*>>> = mutableListOf()

    override fun createNativeModules(context: ReactApplicationContext): MutableList<NativeModule> =
        listOf(HotUpdaterModule(context)).toMutableList()

    companion object {
        /**
         * Gets the app version
         * @param context Application context
         * @return App version name or null if not available
         */
        fun getAppVersion(context: Context): String? = HotUpdaterFactory.getInstance(context).getAppVersion()

        /**
         * Generates a bundle ID based on build timestamp
         * @param context Application context
         * @return The minimum bundle ID string
         */
        fun getMinBundleId(context: Context): String = HotUpdaterFactory.getInstance(context).getMinBundleId()

        /**
         * Gets the current fingerprint hash
         * @param context Application context
         * @return The fingerprint hash or null if not set
         */
        fun getFingerprintHash(context: Context): String? = HotUpdaterFactory.getInstance(context).getFingerprintHash()

        /**
         * Gets the current update channel
         * @param context Application context
         * @return The channel name or null if not set
         */
        fun getChannel(context: Context): String? = HotUpdaterFactory.getInstance(context).getChannel()

        /**
         * Gets the path to the bundle file
         * @param context Application context
         * @return The path to the bundle file
         */
        fun getJSBundleFile(context: Context): String = HotUpdaterFactory.getInstance(context).getJSBundleFile()

        /**
         * Updates the bundle from the specified URL
         * @param context Application context
         * @param bundleId ID of the bundle to update
         * @param fileUrl URL of the bundle file to download (or null to reset)
         * @param progressCallback Callback for download progress updates
         * @return true if the update was successful
         */
        suspend fun updateBundle(
            context: Context,
            bundleId: String,
            fileUrl: String?,
            progressCallback: (Double) -> Unit,
        ): Boolean =
            HotUpdaterFactory.getInstance(context).updateBundle(
                bundleId,
                fileUrl,
                progressCallback,
            )

        /**
         * Reloads the React Native application
         * @param context Application context
         */
        fun reload(context: Context) {
            val currentActivity = getCurrentActivity(context)
            HotUpdaterFactory.getInstance(context).reload(currentActivity)
        }

        /**
         * Gets the current activity from ReactApplicationContext
         * @param context Context that might be a ReactApplicationContext
         * @return The current activity or null
         */
        private fun getCurrentActivity(context: Context): Activity? =
            if (context is ReactApplicationContext) {
                context.currentActivity
            } else {
                null
            }
    }
}
