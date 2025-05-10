package com.hotupdater

import android.app.Activity
import android.content.Context
import android.view.View
import com.facebook.react.ReactApplication
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager
import com.hotupdater.core.HotUpdaterFactory
import com.hotupdater.core.HotUpdaterImpl

/**
 * Main React Native package for HotUpdater
 */
class HotUpdater : ReactPackage {
    override fun createViewManagers(
        context: ReactApplicationContext
    ): MutableList<ViewManager<View, ReactShadowNode<*>>> = mutableListOf()

    override fun createNativeModules(
        context: ReactApplicationContext
    ): MutableList<NativeModule> =
        listOf(HotUpdaterModule(context)).toMutableList()
        
    companion object {
        /**
         * Gets the app version
         * @param context Application context
         * @return App version name or null if not available
         */
        fun getAppVersion(context: Context): String? {
            return HotUpdaterImpl.getAppVersion(context)
        }
        
        /**
         * Generates a bundle ID based on build timestamp
         * @return The minimum bundle ID string
         */
        fun getMinBundleId(): String {
            return HotUpdaterImpl.getMinBundleId()
        }
        
        /**
         * Sets the update channel
         * @param context Application context
         * @param channel The channel name to set
         */
        fun setChannel(context: Context, channel: String) {
            HotUpdaterFactory.getInstance(context).setChannel(channel)
        }
        
        /**
         * Gets the current update channel
         * @param context Application context
         * @return The channel name or null if not set
         */
        fun getChannel(context: Context): String? {
            return HotUpdaterFactory.getInstance(context).getChannel()
        }
        
        /**
         * Gets the path to the bundle file
         * @param context Application context
         * @return The path to the bundle file
         */
        fun getJSBundleFile(context: Context): String {
            return HotUpdaterFactory.getInstance(context).getJSBundleFile()
        }
        
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
            progressCallback: (Double) -> Unit
        ): Boolean {
            return HotUpdaterFactory.getInstance(context).updateBundle(
                bundleId,
                fileUrl,
                progressCallback
            )
        }
        
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
        private fun getCurrentActivity(context: Context): Activity? {
            return if (context is ReactApplicationContext) {
                context.currentActivity
            } else {
                null
            }
        }
    }
}