package com.hotupdater

import android.content.Context
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.JSBundleLoader
import java.lang.reflect.Field

class ReactIntegrationManager(
    context: Context,
) : ReactIntegrationManagerBase(context) {
    fun setJSBundle(
        application: ReactApplication,
        bundleURL: String,
    ) {
        try {
            val instanceManager = application.reactNativeHost.reactInstanceManager
            val bundleLoader: JSBundleLoader? = this.getJSBundlerLoader(bundleURL)
            val bundleLoaderField: Field =
                instanceManager::class.java.getDeclaredField("mBundleLoader")
            bundleLoaderField.isAccessible = true

            if (bundleLoader != null) {
                bundleLoaderField.set(
                    instanceManager,
                    bundleLoader,
                )
            } else {
                bundleLoaderField.set(
                    instanceManager,
                    null,
                )
            }
        } catch (e: Exception) {
            Log.d(
                "HotUpdater",
                "Failed to setJSBundle: ${e.message}",
            )
            throw IllegalAccessException("Could not setJSBundle")
        }
    }

    /**
     * Reload the React Native application.
     */
    fun reload(application: ReactApplication) {
        val reactNativeHost = application.reactNativeHost
        reactNativeHost.reactInstanceManager.recreateReactContextInBackground()
    }
}
