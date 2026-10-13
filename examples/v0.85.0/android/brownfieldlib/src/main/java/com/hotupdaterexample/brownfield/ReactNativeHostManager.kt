package com.hotupdaterexample.brownfield

import android.app.Application
import com.callstack.reactnativebrownfield.ReactNativeBrownfield
import com.facebook.react.PackageList
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.hotupdater.HotUpdater

/** Starts React Native for the brownfield E2E host, as the brownfield guide does. */
object ReactNativeHostManager {
    fun start(application: Application) {
        ReactNativeBrownfield.initialize(application) {
            getDefaultReactHost(
                context = application,
                packageList = PackageList(application).packages,
                jsMainModulePath = "index",
                jsBundleAssetPath = "index.android.bundle",
                jsBundleFilePath = HotUpdater.getJSBundleFile(application),
                useDevSupport = false,
                jsRuntimeFactory = null,
            )
        }
        HotUpdater.setReactHost(ReactNativeBrownfield.shared.reactHost)
    }
}
