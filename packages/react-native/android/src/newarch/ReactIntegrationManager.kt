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

            // Try both Java and Kotlin field names for compatibility
            val reactHostDelegateField =
                try {
                    reactHost::class.java.getDeclaredField("mReactHostDelegate")
                } catch (e: NoSuchFieldException) {
                    try {
                        reactHost::class.java.getDeclaredField("reactHostDelegate")
                    } catch (e2: NoSuchFieldException) {
                        throw RuntimeException("Neither mReactHostDelegate nor reactHostDelegate field found", e2)
                    }
                }

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
                // Fallback to old architecture if ReactHost is not available
                @Suppress("DEPRECATION")
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
                val activity = reactHost.currentReactContext?.currentActivity
                if (reactHost.lifecycleState != LifecycleState.RESUMED && activity != null) {
                    reactHost.onHostResume(activity)
                }
                reactHost.reload("Requested by HotUpdater")
            } else {
                // Fallback to old architecture if ReactHost is not available
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
                } catch (e: Exception) {
                    Log.d("HotUpdater", "Failed to reload: ${e.message}")
                }
            }
        } catch (e: Exception) {
            Log.d("HotUpdater", "Failed to reload: ${e.message}")
        }
    }
}
