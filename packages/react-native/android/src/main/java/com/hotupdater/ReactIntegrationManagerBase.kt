package com.hotupdater

import android.app.Application
import android.content.Context
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.JSBundleLoader

open class ReactIntegrationManagerBase(
    private val context: Context,
) {
    fun getJSBundlerLoader(bundleFileUrl: String): JSBundleLoader? {
        val bundleLoader: JSBundleLoader?

        if (bundleFileUrl.lowercase().startsWith("assets://")) {
            bundleLoader =
                JSBundleLoader.createAssetLoader(
                    context,
                    bundleFileUrl,
                    false,
                )
        } else {
            bundleLoader = JSBundleLoader.createFileLoader(bundleFileUrl)
        }
        return bundleLoader
    }

    public fun getReactApplication(application: Application?): ReactApplication {
        if (application is ReactApplication) {
            return application
        } else {
            throw IllegalArgumentException("Application does not implement ReactApplication")
        }
    }
}
