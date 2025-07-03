package com.hotupdater

import android.content.Context
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.JSBundleLoader
import java.lang.reflect.Field

class ReactIntegrationManager(
    context: Context,
) : ReactIntegrationManagerBase(context) {
    public fun setJSBundle(
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
        try {
            val reactNativeHost = application.reactNativeHost
            val reactInstanceManager = reactNativeHost.reactInstanceManager
            
            // Check if React instance is available before attempting reload
            val currentReactContext = reactInstanceManager.currentReactContext
            if (currentReactContext == null) {
                Log.d("HotUpdater", "ReactContext is null, cannot reload safely")
                return
            }
            
            try {
                reactInstanceManager.recreateReactContextInBackground()
            } catch (e: Exception) {
                Log.d("HotUpdater", "Failed to recreate context in background: ${e.message}")
                
                // Fallback to activity recreation if available
                val currentActivity = currentReactContext.currentActivity
                if (currentActivity == null) {
                    Log.d("HotUpdater", "No current activity available for fallback reload")
                    return
                }

                try {
                    currentActivity.runOnUiThread {
                        currentActivity.recreate()
                    }
                } catch (e: Exception) {
                    Log.d("HotUpdater", "Failed to recreate activity: ${e.message}")
                }
            }
        } catch (e: Exception) {
            Log.d("HotUpdater", "Failed to reload: ${e.message}")
        }
    }
}
