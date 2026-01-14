package com.hotupdater

import android.content.Context
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.ReactInstanceManager
import com.facebook.react.bridge.JSBundleLoader
import com.facebook.react.bridge.ReactContext
import kotlinx.coroutines.suspendCancellableCoroutine
import java.lang.reflect.Field
import kotlin.coroutines.resume

class ReactIntegrationManager(
    context: Context,
) : ReactIntegrationManagerBase(context) {
    /**
     * Sets the JS bundle using the host set via HotUpdater.setReactHost() (for brownfield apps)
     * Note: Not supported in old architecture, always returns false
     * @param bundleURL The bundle URL to set
     * @return false (not supported in old architecture)
     */
    public fun setJSBundle(bundleURL: String): Boolean {
        // Not supported in old architecture
        return false
    }

    /**
     * Reloads the React Native application using the host set via HotUpdater.setReactHost() (for brownfield apps)
     * Note: Not supported in old architecture, always returns false
     * @return false (not supported in old architecture)
     */
    public suspend fun reload(): Boolean {
        // Not supported in old architecture
        return false
    }

    /**
     * Sets the JS bundle using ReactInstanceManager directly (for brownfield apps)
     * @param instanceManager The ReactInstanceManager instance
     * @param bundleURL The bundle URL to set
     */
    public fun setJSBundle(
        instanceManager: ReactInstanceManager,
        bundleURL: String,
    ) {
        try {
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
            Log.d("HotUpdater", "Failed to setJSBundle with ReactInstanceManager: ${e.message}")
        }
    }

    public fun setJSBundle(
        application: ReactApplication,
        bundleURL: String,
    ) {
        try {
            val instanceManager = application.reactNativeHost.reactInstanceManager
            setJSBundle(instanceManager, bundleURL)
        } catch (e: Exception) {
            Log.d("HotUpdater", "Failed to setJSBundle: ${e.message}")
        }
    }

    /**
     * Reload the React Native application using ReactInstanceManager directly.
     * Caller should run this on main thread.
     * @param instanceManager The ReactInstanceManager instance
     */
    public suspend fun reload(instanceManager: ReactInstanceManager) {
        try {
            // Ensure initialized; if not, start and wait
            waitForReactContextInitialized(instanceManager)

            instanceManager.recreateReactContextInBackground()
        } catch (e: Exception) {
            val currentActivity = instanceManager.currentReactContext?.currentActivity
            if (currentActivity == null) {
                return
            }

            currentActivity.runOnUiThread {
                currentActivity.recreate()
            }
        } catch (e: Exception) {
            Log.d("HotUpdater", "Failed to reload with ReactInstanceManager: ${e.message}")
        }
    }

    /**
     * Reload the React Native application, ensuring ReactContext is initialized first.
     * Caller should run this on main thread.
     */
    public suspend fun reload(application: ReactApplication) {
        val instanceManager = application.reactNativeHost.reactInstanceManager
        reload(instanceManager)
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

    /**
     * Waits until ReactContext is initialized.
     * @return true if ReactContext was already initialized; false if we waited for it.
     */
    suspend fun waitForReactContextInitialized(application: ReactApplication): Boolean {
        val reactInstanceManager = application.reactNativeHost.reactInstanceManager
        return waitForReactContextInitialized(reactInstanceManager)
    }
}
