package com.hotupdater

import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.JSBundleLoader
import com.facebook.react.bridge.ReactApplicationContext
import java.lang.reflect.Field

class ReactIntegrationManager(
    reactContext: ReactApplicationContext,
) : ReactIntegrationManagerBase(reactContext) {
    public fun setJSBundle(
        application: ReactApplication,
        bundleURL: String,
    ) {
        val reactHost = application.reactHost
        // println("ReactIntegrationManager.setJSBundle: $bundleURL")
        Log.d("ReactIntegrationManager", "ReactIntegrationManager.setJSBundle: $bundleURL")
        Log.d("ReactIntegrationManager", "ReactIntegrationManager.reactHost: $reactHost")

        reactHost
            .try {
                val instanceManager = application.reactNativeHost.reactInstanceManager
                val bundleLoader: JSBundleLoader? = this.getJSBundlerLoader(bundleURL, bundleURL)
                val bundleLoaderField: Field =
                    instanceManager::class.java.getDeclaredField("mBundleLoader")
                bundleLoaderField.isAccessible = true

                if (bundleLoader != null) {
                    bundleLoaderField.set(instanceManager, bundleLoader)
                } else {
                    bundleLoaderField.set(instanceManager, null)
                }
            } catch (e: Exception) {
                Log.d("HotUpdater", "Failed to setJSBundle: ${e.message}")
            }
    }

    /**
     * Reload the React Native application.
     */
    public fun reload(application: ReactApplication) {
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
        } catch (e: Exception) {
            Log.d("HotUpdater", "Failed to reload: ${e.message}")
        }
    }
}
