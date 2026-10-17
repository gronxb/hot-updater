package com.hotupdater

import android.content.Context
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.ReactRootView
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContext
import com.facebook.react.common.LifecycleState
import com.facebook.react.interfaces.fabric.ReactSurface
import kotlinx.coroutines.suspendCancellableCoroutine
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
            // Try _jsBundleLoader first (Expo SDK 55+ ExpoReactHostDelegate uses a computed
            // property with a private backing field), then fall back to jsBundleLoader
            // (DefaultReactHostDelegate and older Expo versions).
            val jsBundleLoaderField =
                try {
                    reactHostDelegate::class.java.getDeclaredField("_jsBundleLoader")
                } catch (e: NoSuchFieldException) {
                    reactHostDelegate::class.java.getDeclaredField("jsBundleLoader")
                }
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
            rearmContentAppearedAfterReload(reactHost)
            reactHost.reload("Requested by HotUpdater")
        } catch (e: Exception) {
            Log.d("HotUpdater", "Failed to reload with ReactHost: ${e.message}")
        }
    }

    /**
     * Lets the reloaded bundle log its first content.
     *
     * ReactHost.reload() restarts the surfaces it already has instead of creating
     * new ones, and only surface creation arms ReactRootView's CONTENT_APPEARED
     * marker. Without it the reloaded launch is never verified, and the next cold
     * start rolls it back as one that ended before its first content.
     *
     * The surfaces are armed once the new instance exists: by then reload has
     * stopped and cleared them, so the old bundle cannot log content for the new
     * one, and the new bundle has not mounted anything yet.
     */
    private fun rearmContentAppearedAfterReload(reactHost: ReactHost) {
        val listener =
            object : ReactInstanceEventListener {
                override fun onReactContextInitialized(context: ReactContext) {
                    reactHost.removeReactInstanceEventListener(this)
                    attachedSurfaceViews(reactHost).forEach { view ->
                        view.setShouldLogContentAppeared(true)
                    }
                }
            }
        reactHost.addReactInstanceEventListener(listener)
    }

    // ReactHostImpl keeps its surfaces in a private field: mAttachedSurfaces while
    // it was Java, attachedSurfaces since it moved to Kotlin.
    private fun attachedSurfaceViews(reactHost: ReactHost): List<ReactRootView> =
        try {
            val field =
                HotUpdaterRecoveryManager.findField(reactHost::class.java, "attachedSurfaces")
                    ?: HotUpdaterRecoveryManager.findField(reactHost::class.java, "mAttachedSurfaces")
                    ?: throw NoSuchFieldException("attachedSurfaces")
            field.isAccessible = true
            val surfaces = field.get(reactHost) as Set<*>
            synchronized(surfaces) {
                surfaces.mapNotNull { (it as? ReactSurface)?.view as? ReactRootView }
            }
        } catch (e: Exception) {
            Log.d("HotUpdater", "Failed to read ReactHost surfaces: ${e.message}")
            emptyList()
        }

    private fun getReactApplication(): ReactApplication? {
        if (context is ReactApplicationContext) {
            val activity = context.currentActivity
            val application = activity?.application
            if (application is ReactApplication) {
                return application
            }
        }

        return null
    }

    /**
     * Sets the JS bundle.
     * Priority: ReactHostHolder (if set) > application.reactHost > the bridge (React Native 0.81 and older)
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
            val application = getReactApplication()
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

            // 4. Fall back to the bridge, which React Native 0.81 and older can run
            BridgeReactInstance.setJSBundle(application, getJSBundlerLoader(bundleURL))
        } catch (e: Exception) {
            Log.d("HotUpdater", "Failed to setJSBundle: ${e.message}")
        }
    }

    /**
     * Reload the React Native application.
     * Priority: ReactHostHolder (if set) > application.reactHost > the bridge (React Native 0.81 and older)
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
            val application = getReactApplication()
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

            // 4. Fall back to the bridge, which React Native 0.81 and older can run
            BridgeReactInstance.reload(application)
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
