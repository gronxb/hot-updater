package com.hotupdater

import android.content.Context
import android.util.Log
import com.facebook.react.ReactApplication

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
            Log.d("HotUpdater", "Failed to setJSBundle: ${e.message}")
            throw IllegalAccessException("Could not setJSBundle")
        }
    }

    public fun reload(application: ReactApplication) {
        val reactHost = application.reactHost
        check(reactHost != null)
        if (reactHost.lifecycleState != LifecycleState.RESUMED && activity != null) {
            reactHost.onHostResume(activity)
        }
        reactHost.reload("Requested by HotUpdater")
    }
}
