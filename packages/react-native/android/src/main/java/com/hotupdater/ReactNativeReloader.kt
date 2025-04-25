package com.hotupdater

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceManager
import com.facebook.react.bridge.ReactApplicationContext

class ReactNativeReloader(
    private val context: Context,
) {
    private val reactIntegrationManager = ReactIntegrationManager(context)

    private fun getCurrentActivity(): Activity? =
        if (context is ReactApplicationContext) {
            context.currentActivity
        } else {
            // Attempt to get activity from Application context if possible
            // This might require a more sophisticated approach depending on the app structure
            Log.w(TAG, "Context is not ReactApplicationContext, cannot reliably get current activity.")
            null
        }

    private fun getReactApplication(): ReactApplication? {
        val activity: Activity? = getCurrentActivity()
        val application: Application? =
            activity?.application ?: if (context.applicationContext is Application) context.applicationContext as Application else null

        return if (application is ReactApplication) {
            application
        } else {
            Log.e(TAG, "Application is not a ReactApplication")
            null
        }
    }

    fun applyBundle(bundlePath: String?) {
        val reactApplication = getReactApplication() ?: return
        val newBundleUrl = bundlePath ?: getDefaultBundleUrl()
        Log.d(TAG, "Applying bundle: $newBundleUrl")
        reactIntegrationManager.setJSBundle(reactApplication, newBundleUrl)
    }

    fun reload() {
        val reactApplication = getReactApplication() ?: return
        Handler(Looper.getMainLooper()).post {
            Log.d(TAG, "Reloading React Native application")
            reactIntegrationManager.reload(reactApplication)
        }
    }

    fun getCurrentBundleUrl(): String {
        val prefs = HotUpdaterPreferenceManager.getInstance(context)
        val urlString = prefs.getItem(HotUpdaterPreferenceManager.KEY_BUNDLE_URL)
        if (!urlString.isNullOrEmpty()) {
            val file = java.io.File(urlString)
            if (file.exists()) {
                return urlString
            }
            // If file doesn't exist, clear the preference and return default
            Log.w(TAG, "Stored bundle URL $urlString not found, reverting to default.")
            prefs.setItem(HotUpdaterPreferenceManager.KEY_BUNDLE_URL, null)
        }
        return getDefaultBundleUrl()
    }

    private fun getDefaultBundleUrl(): String = "assets://index.android.bundle"

    companion object {
        private const val TAG = "ReactNativeReloader"
    }

    // Helper class assumed from original code context
    private class ReactIntegrationManager(
        context: Context,
    ) {
        private val mContext = context

        // These methods would interact with the actual ReactInstanceManager
        fun getReactApplication(application: Application?): ReactApplication {
            if (application is ReactApplication) {
                return application
            }
            // This is a fallback/assumption, real implementation might differ
            throw IllegalStateException("Application is not a ReactApplication")
        }

        fun setJSBundle(
            reactApplication: ReactApplication,
            jsBundleFile: String,
        ) {
            try {
                val instanceManager = reactApplication.reactNativeHost.reactInstanceManager
                // Use reflection to set the JS bundle file
                val jsBundleLoaderField = ReactInstanceManager::class.java.getDeclaredField("mJSBundleLoader")
                jsBundleLoaderField.isAccessible = true
                val jsBundleLoader = jsBundleLoaderField.get(instanceManager)

                val jsBundleLoaderClass: Class<*>? =
                    try {
                        Class.forName("com.facebook.react.cxxbridge.JSBundleLoader")
                    } catch (e: ClassNotFoundException) {
                        try {
                            Class.forName("com.facebook.react.bridge.JSBundleLoader")
                        } catch (e2: ClassNotFoundException) {
                            Log.e(TAG, "Could not find JSBundleLoader class", e2)
                            return
                        }
                    }

                if (jsBundleLoaderClass != null) {
                    val mBundleUrlField = jsBundleLoaderClass.getDeclaredField("mBundleUrl")
                    mBundleUrlField.isAccessible = true
                    mBundleUrlField.set(jsBundleLoader, jsBundleFile)
                    Log.d(TAG, "Successfully set JSBundle to: $jsBundleFile")
                } else {
                    Log.e(TAG, "JSBundleLoader class not found.")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Could not set JS Bundle file via reflection", e)
                // Fallback or alternative method might be needed depending on RN version
                try {
                    val instanceManager = reactApplication.reactNativeHost.reactInstanceManager
                    val setJSBundleFileMethod = instanceManager.javaClass.getDeclaredMethod("setJSBundleFile", String::class.java)
                    setJSBundleFileMethod.isAccessible = true
                    setJSBundleFileMethod.invoke(instanceManager, jsBundleFile)
                    Log.d(TAG, "Successfully set JSBundle via setJSBundleFile method to: $jsBundleFile")
                } catch (e2: Exception) {
                    Log.e(TAG, "Could not set JS Bundle file via setJSBundleFile method", e2)
                    // Consider throwing or handling this failure more gracefully
                }
            }
        }

        fun reload(reactApplication: ReactApplication) {
            val instanceManager = reactApplication.reactNativeHost.reactInstanceManager
            instanceManager.devSupportManager.handleReloadJS()
        }
    }
}
