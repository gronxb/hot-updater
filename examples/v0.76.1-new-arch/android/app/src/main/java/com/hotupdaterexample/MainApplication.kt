package com.hotupdaterexample

import android.app.Application
import android.util.Log
import android.content.Context
import androidx.core.content.edit
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader
import java.io.File

class MainApplication :
    Application(),
    ReactApplication {
    override val reactNativeHost: ReactNativeHost =
        object : DefaultReactNativeHost(this) {
            override fun getPackages(): List<ReactPackage> =
                PackageList(this).packages.apply {
                    // Packages that cannot be autolinked yet can be added manually here, for example:
                    // add(MyReactNativePackage())
                }

            override fun getJSMainModuleName(): String = "index"

            override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

            override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
            override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED

            override fun getJSBundleFile(): String? {
                val sharedPreferences = applicationContext.getSharedPreferences(
                    "HotUpdaterPrefs",
                    Context.MODE_PRIVATE
                )
                val urlString = sharedPreferences.getString(
                    "HotUpdaterBundleURL",
                    null
                )
                if (urlString.isNullOrEmpty()) {
                    return "assets://index.android.bundle"
                }

                val file = File(urlString)
                if (!file.exists()) {
                    sharedPreferences.edit {
                        putString(
                            "HotUpdaterBundleURL",
                            null
                        )
                    }
                    return "assets://index.android.bundle"
                }

                return urlString
            }
        }

    override val reactHost: ReactHost
        get() = getDefaultReactHost(
            applicationContext,
            reactNativeHost
        )

    override fun onCreate() {
        super.onCreate()
        SoLoader.init(
            this,
            OpenSourceMergedSoMapping
        )

        if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
            // If you opted-in for the New Architecture, we load the native entry point for this app.
            load()
        }
    }
}
