package com.hotupdater

import android.app.Application
import android.content.Context
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.JSBundleLoader
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContext
import com.facebook.react.common.LifecycleState
import kotlinx.coroutines.suspendCancellableCoroutine
import java.lang.reflect.Field
import kotlin.coroutines.resume

class ReactIntegrationManager(
    private val context: Context,
) : ReactIntegrationManagerBase(context) {
    /**
     * Sets the JS bundle using ReactHost directly
     * @param reactHost The ReactHost instance
     * @param bundleURL The bundle URL to set
     */
    private fun setJSBundleInternal(
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

    /**
     * Reload the React Native application using ReactHost directly.
     * @param reactHost The ReactHost instance
     */
    private suspend fun reloadInternal(reactHost: ReactHost) {
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
     * Gets the ReactApplication from context if available
     * Priority: ReactApplicationContext.currentActivity.application > context.applicationContext
     * @return ReactApplication or null if not available
     */
    private fun getReactApplicationFromContext(): ReactApplication? {
        // 1. Try to get from ReactApplicationContext's current activity
        if (context is ReactApplicationContext) {
            val activity = context.currentActivity
            val application = activity?.application
            if (application is ReactApplication) {
                return application
            }
        }

        // 2. Fallback to context.applicationContext
        val application = context.applicationContext as? Application
        return application as? ReactApplication
    }

    /**
     * Sets the JS bundle.
     * Priority: ReactHostHolder (if set) > application.reactHost > reactNativeHost
     * @param bundleURL The bundle URL to set
     */
    public fun setJSBundle(bundleURL: String) {
        try {
            // 1. First, check if ReactHost was set via HotUpdater.setReactHost()
            val configuredHost = ReactHostHolder.getReactHost()
            if (configuredHost != null) {
                setJSBundleInternal(configuredHost, bundleURL)
                return
            }

            // 2. Try to get ReactApplication from context
            val application = getReactApplicationFromContext()
            if (application == null) {
                Log.d("HotUpdater", "No ReactHost set and application is not ReactApplication")
                return
            }

            // 3. Try application's ReactHost (new architecture)
            val reactHost = application.reactHost
            if (reactHost != null) {
                setJSBundleInternal(reactHost, bundleURL)
                return
            }

            // 4. Fallback to old architecture (reactNativeHost)
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
            Log.d("HotUpdater", "Failed to setJSBundle: ${e.message}")
        }
    }

    /**
     * Reload the React Native application.
     * Priority: ReactHostHolder (if set) > application.reactHost > reactNativeHost
     */
    public suspend fun reload() {
        try {
            // 1. First, check if ReactHost was set via HotUpdater.setReactHost()
            val configuredHost = ReactHostHolder.getReactHost()
            if (configuredHost != null) {
                reloadInternal(configuredHost)
                return
            }

            // 2. Try to get ReactApplication from context
            val application = getReactApplicationFromContext()
            if (application == null) {
                Log.d("HotUpdater", "No ReactHost set and application is not ReactApplication")
                return
            }

            // 3. Try application's ReactHost (new architecture)
            val reactHost = application.reactHost
            if (reactHost != null) {
                reloadInternal(reactHost)
                return
            }

            // 4. Fallback to old architecture (reactNativeHost)
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
