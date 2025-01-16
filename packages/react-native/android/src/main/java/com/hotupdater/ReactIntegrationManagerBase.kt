package com.hotupdater

import android.app.Application
import android.content.Context
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.JSBundleLoader

open class ReactIntegrationManagerBase(
    private val context: Context,
) {
    fun getJSBundlerLoader(bundleFileUrl: String): JSBundleLoader? {
        val bundleLoader: JSBundleLoader? =
            if (bundleFileUrl.lowercase().startsWith("assets://")) {
                JSBundleLoader.createAssetLoader(
                    context,
                    bundleFileUrl,
                    true,
                )
            } else {
                JSBundleLoader.createFileLoader(bundleFileUrl)
            }
        return bundleLoader
    }

    fun getReactApplication(application: Application?): ReactApplication {
        if (application is ReactApplication) {
            return application
        } else {
            throw IllegalArgumentException("Application does not implement ReactApplication")
        }
    }
}
