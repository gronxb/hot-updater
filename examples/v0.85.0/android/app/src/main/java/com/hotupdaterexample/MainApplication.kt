package com.hotupdaterexample

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.hotupdater.HotUpdater

class MainApplication : Application(), ReactApplication {
  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
        context = applicationContext,
        packageList =
            PackageList(this).packages.apply {
              add(ReloadCrashProbePackage())
            },
        jsBundleFilePath =
            if (BuildConfig.DEBUG) {
              null
            } else {
              HotUpdater.getJSBundleFile(applicationContext)
            },
        useDevSupport =
            BuildConfig.DEBUG && !BuildConfig.HOT_UPDATER_E2E_DISABLE_DEV_SUPPORT,
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
