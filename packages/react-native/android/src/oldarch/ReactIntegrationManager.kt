package com.hotupdater

import android.app.Application
import android.content.Context
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.ReactInstanceManager
import com.facebook.react.bridge.JSBundleLoader
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContext
import kotlinx.coroutines.suspendCancellableCoroutine
import java.lang.reflect.Field
import kotlin.coroutines.resume

class ReactIntegrationManager(
    private val context: Context,
) : ReactIntegrationManagerBase(context) {
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
     * Gets ReactApplication from context and uses reactNativeHost.
     * @param bundleURL The bundle URL to set
     */
    public fun setJSBundle(bundleURL: String) {
        try {
            val application = getReactApplicationFromContext()
            if (application == null) {
                Log.d("HotUpdater", "Application is not ReactApplication")
                return
            }

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
     * Gets ReactApplication from context and uses reactNativeHost.
     */
    public suspend fun reload() {
        try {
            val application = getReactApplicationFromContext()
            if (application == null) {
                Log.d("HotUpdater", "Application is not ReactApplication")
                return
            }

            val instanceManager = application.reactNativeHost.reactInstanceManager

            // Ensure initialized; if not, start and wait
            waitForReactContextInitialized(instanceManager)

            instanceManager.recreateReactContextInBackground()
        } catch (e: Exception) {
            try {
                val application = getReactApplicationFromContext() ?: return
                val instanceManager = application.reactNativeHost.reactInstanceManager
                val currentActivity = instanceManager.currentReactContext?.currentActivity
                if (currentActivity == null) {
                    return
                }

                currentActivity.runOnUiThread {
                    currentActivity.recreate()
                }
            } catch (e2: Exception) {
                Log.d("HotUpdater", "Failed to reload: ${e2.message}")
            }
        }
    }

    /**
     * Waits until ReactContext is initialized using ReactInstanceManager.
     * @param instanceManager The ReactInstanceManager instance
     * @return true if ReactContext was already initialized; false if we waited for it.
     */
    suspend fun waitForReactContextInitialized(instanceManager: ReactInstanceManager): Boolean {
        // If already initialized, return immediately and indicate so
        if (instanceManager.currentReactContext != null) return true

        // Otherwise, wait for initialization; MainApplication handles starting the instance
        suspendCancellableCoroutine { continuation ->
            val listener =
                object : ReactInstanceEventListener {
                    override fun onReactContextInitialized(context: ReactContext) {
                        instanceManager.removeReactInstanceEventListener(this)
                        if (continuation.isActive) continuation.resume(Unit)
                    }
                }

            instanceManager.addReactInstanceEventListener(listener)
            continuation.invokeOnCancellation { instanceManager.removeReactInstanceEventListener(listener) }
        }
        return false
    }
}
