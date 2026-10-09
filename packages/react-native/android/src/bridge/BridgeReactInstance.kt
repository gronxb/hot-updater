package com.hotupdater

import com.facebook.react.ReactApplication
import com.facebook.react.bridge.JSBundleLoader

/**
 * React Native 0.81 and older can run the New Architecture on the bridge, which
 * only ReactNativeHost reaches. Only builds for those versions compile this file.
 */
internal object BridgeReactInstance {
    fun setJSBundle(
        application: ReactApplication,
        bundleLoader: JSBundleLoader?,
    ) {
        @Suppress("DEPRECATION")
        val instanceManager = application.reactNativeHost.reactInstanceManager
        val bundleLoaderField = instanceManager::class.java.getDeclaredField("mBundleLoader")
        bundleLoaderField.isAccessible = true
        bundleLoaderField.set(instanceManager, bundleLoader)
    }

    fun reload(application: ReactApplication) {
        @Suppress("DEPRECATION")
        val reactNativeHost = application.reactNativeHost
        try {
            reactNativeHost.reactInstanceManager.recreateReactContextInBackground()
        } catch (e: Exception) {
            val currentActivity = reactNativeHost.reactInstanceManager.currentReactContext?.currentActivity
            if (currentActivity == null) {
                return
            }

            currentActivity.runOnUiThread {
                currentActivity.recreate()
            }
        }
    }
}
