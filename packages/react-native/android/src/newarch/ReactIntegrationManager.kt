package com.hotupdater

import android.content.Context
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.JSBundleLoader
import com.facebook.react.common.LifecycleState
import java.lang.reflect.Field

class ReactIntegrationManager(
    context: Context,
) : ReactIntegrationManagerBase(context) {
    public fun setJSBundle(
        application: ReactApplication,
        bundleURL: String,
    ) {
        try {
            val reactHost = application.reactHost
            check(reactHost != null)
            val reactHostDelegateField = reactHost::class.java.getDeclaredField("mReactHostDelegate")
            reactHostDelegateField.isAccessible = true
            val reactHostDelegate =
                reactHostDelegateField.get(
                    reactHost,
                )
            val jsBundleLoaderField = reactHostDelegate::class.java.getDeclaredField("jsBundleLoader")
            jsBundleLoaderField.isAccessible = true
            jsBundleLoaderField.set(reactHostDelegate, getJSBundlerLoader(bundleURL))
        } catch (e: Exception) {
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
                Log.d("HotUpdater", "Failed to setJSBundle (fallback): ${e.message}")
            }
            Log.d("HotUpdater", "Failed to setJSBundle: ${e.message}")
        }
    }

    /**
     * Reload the React Native application.
     */
    public fun reload(application: ReactApplication) {
        try {
            val reactHost = application.reactHost
            if (reactHost != null) {
                val currentReactContext = reactHost.currentReactContext
                if (currentReactContext != null) {
                    val activity = currentReactContext.currentActivity
                    if (reactHost.lifecycleState != LifecycleState.RESUMED && activity != null) {
                        reactHost.onHostResume(activity)
                    }
                    reactHost.reload("Requested by HotUpdater")
                } else {
                    Log.d("HotUpdater", "ReactContext is null, cannot reload safely")
                }
            } else {
                val reactNativeHost = application.reactNativeHost
                try {
                    reactNativeHost.reactInstanceManager.recreateReactContextInBackground()
                } catch (e: Exception) {
                    Log.d("HotUpdater", "Failed to recreate context in background: ${e.message}")
                    
                    val currentReactContext = reactNativeHost.reactInstanceManager.currentReactContext
                    val currentActivity = currentReactContext?.currentActivity
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
            }
        } catch (e: Exception) {
            Log.d("HotUpdater", "Failed to reload: ${e.message}")
        }
    }
}
