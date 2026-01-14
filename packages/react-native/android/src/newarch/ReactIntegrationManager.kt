package com.hotupdater

import android.content.Context
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.JSBundleLoader
import com.facebook.react.bridge.ReactContext
import com.facebook.react.common.LifecycleState
import kotlinx.coroutines.suspendCancellableCoroutine
import java.lang.reflect.Field
import kotlin.coroutines.resume

class ReactIntegrationManager(
    context: Context,
) : ReactIntegrationManagerBase(context) {
    /**
     * Sets the JS bundle using the ReactHost set via HotUpdater.setReactHost() (for brownfield apps)
     * @param bundleURL The bundle URL to set
     * @return true if successful, false if no ReactHost is set
     */
    public fun setJSBundle(bundleURL: String): Boolean {
        val host = HotUpdater.getReactHost()
        if (host is ReactHost) {
            setJSBundle(host, bundleURL)
            return true
        }
        return false
    }

    /**
     * Reloads the React Native application using the ReactHost set via HotUpdater.setReactHost() (for brownfield apps)
     * @return true if successful, false if no ReactHost is set
     */
    public suspend fun reload(): Boolean {
        val host = HotUpdater.getReactHost()
        if (host is ReactHost) {
            reload(host)
            return true
        }
        return false
    }

    /**
     * Sets the JS bundle using ReactHost directly (for brownfield apps)
     * @param reactHost The ReactHost instance
     * @param bundleURL The bundle URL to set
     */
    public fun setJSBundle(
        reactHost: ReactHost,
        bundleURL: String,
    ) {
        try {
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
            val reactHostDelegate = reactHostDelegateField.get(reactHost)
            val jsBundleLoaderField = reactHostDelegate::class.java.getDeclaredField("jsBundleLoader")
            jsBundleLoaderField.isAccessible = true
            jsBundleLoaderField.set(reactHostDelegate, getJSBundlerLoader(bundleURL))
        } catch (e: Exception) {
            Log.d("HotUpdater", "Failed to setJSBundle with ReactHost: ${e.message}")
        }
    }

    public fun setJSBundle(
        application: ReactApplication,
        bundleURL: String,
    ) {
        try {
            val reactHost = application.reactHost
            if (reactHost != null) {
                setJSBundle(reactHost, bundleURL)
            } else {
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
            }
        } catch (e: Exception) {
            Log.d("HotUpdater", "Failed to setJSBundle: ${e.message}")
        }
    }

    /**
     * Reload the React Native application using ReactHost directly (for brownfield apps).
     * Caller should run this on main thread.
     * @param reactHost The ReactHost instance
     */
    public suspend fun reload(reactHost: ReactHost) {
        try {
            // Ensure initialized; if not, start and wait
            waitForReactContextInitialized(reactHost)

            val activity = reactHost.currentReactContext?.currentActivity
            if (reactHost.lifecycleState != LifecycleState.RESUMED && activity != null) {
                reactHost.onHostResume(activity)
            }
            reactHost.reload("Requested by HotUpdater")
        } catch (e: Exception) {
            Log.d("HotUpdater", "Failed to reload with ReactHost: ${e.message}")
        }
    }

    /**
     * Reload the React Native application, ensuring ReactContext is initialized first.
     * Caller should run this on main thread.
     */
    public suspend fun reload(application: ReactApplication) {
        try {
            val reactHost = application.reactHost
            if (reactHost != null) {
                reload(reactHost)
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

    /**
     * Waits until ReactContext is initialized.
     * @return true if ReactContext was already initialized; false if we waited for it.
     */
    suspend fun waitForReactContextInitialized(reactHost: ReactHost): Boolean {
        return try {
            // If already initialized, return immediately
            if (reactHost.currentReactContext != null) return true

            // Wait for initialization; MainApplication handles starting the host
            suspendCancellableCoroutine { continuation ->
                val listener =
                    object : ReactInstanceEventListener {
                        override fun onReactContextInitialized(context: ReactContext) {
                            reactHost.removeReactInstanceEventListener(this)
                            if (continuation.isActive) continuation.resume(Unit)
                        }
                    }

                reactHost.addReactInstanceEventListener(listener)
                continuation.invokeOnCancellation { reactHost.removeReactInstanceEventListener(listener) }
            }
            false
        } catch (e: Exception) {
            Log.d("HotUpdater", "waitForReactContextInitialized failed: ${e.message}")
            true
        }
    }
}
