package com.hotupdater

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.JSBundleLoader
import com.facebook.react.bridge.ReactContext
import kotlinx.coroutines.suspendCancellableCoroutine
import java.lang.reflect.Field
import kotlin.coroutines.resume

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
     * Reload the React Native application, ensuring ReactContext is initialized first.
     * Caller should run this on main thread.
     */
    public suspend fun reload(application: ReactApplication) {
        val reactNativeHost = application.reactNativeHost
        try {
            // Ensure initialized; if not, start and wait
            waitForReactContextInitialized(application)

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

    /**
     * Waits until ReactContext is initialized.
     * @return true if ReactContext was already initialized; false if we waited for it.
     */
    suspend fun waitForReactContextInitialized(application: ReactApplication): Boolean {
        val reactInstanceManager = application.reactNativeHost.reactInstanceManager

        // If already initialized, return immediately and indicate so
        if (reactInstanceManager.currentReactContext != null) return true

        // Otherwise, wait for initialization and ensure creation starts
        suspendCancellableCoroutine { cont ->
            val listener =
                object : ReactInstanceEventListener {
                    override fun onReactContextInitialized(context: ReactContext) {
                        reactInstanceManager.removeReactInstanceEventListener(this)
                        if (cont.isActive) cont.resume(Unit)
                    }
                }

            reactInstanceManager.addReactInstanceEventListener(listener)
            cont.invokeOnCancellation { reactInstanceManager.removeReactInstanceEventListener(listener) }

            // Start creating ReactContext on the main thread (idempotent)
            Handler(Looper.getMainLooper()).post { reactInstanceManager.createReactContextInBackground() }
        }
        return false
    }
}
