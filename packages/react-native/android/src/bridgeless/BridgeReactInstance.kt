package com.hotupdater

import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.JSBundleLoader

/**
 * React Native 0.82 and later have no bridge, so an app without a ReactHost has
 * no instance to update. Builds for those versions compile this file instead of
 * the bridge one, and never reference ReactNativeHost.
 */
@Suppress("UNUSED_PARAMETER")
internal object BridgeReactInstance {
    fun setJSBundle(
        application: ReactApplication,
        bundleLoader: JSBundleLoader?,
    ) {
        Log.d("HotUpdater", "No ReactHost to set the JS bundle on")
    }

    fun reload(application: ReactApplication) {
        Log.d("HotUpdater", "No ReactHost to reload")
    }
}
