package com.rnbrownfieldreact

import android.app.Application
import com.callstack.reactnativebrownfield.OnJSBundleLoaded
import com.callstack.reactnativebrownfield.ReactNativeBrownfield
import com.facebook.react.PackageList
import com.hotupdater.HotUpdater

/**
 * Entry point for host apps: call `initialize` once from `Application.onCreate`.
 * `ReactNativeBrownfield.initialize` loads the React Native native libraries
 * itself, so the host must not call `loadReactNative` as well: doing both
 * overrides React Native's feature flags twice and crashes at startup.
 */
object ReactNativeHostManager {
    fun initialize(application: Application, onJSBundleLoaded: OnJSBundleLoaded? = null) {
        val options = hashMapOf<String, Any>(
            "packages" to PackageList(application).packages,
            "mainModuleName" to "index",
            // Hot Updater picks the bundle: the last update it downloaded and
            // verified, or `assets://index.android.bundle` embedded in this AAR.
            // Its channel and fingerprint come from the meta-data in this
            // module's AndroidManifest.xml, merged into the host's manifest.
            "bundleFilePath" to HotUpdater.getJSBundleFile(application),
            "useDeveloperSupport" to BuildConfig.DEBUG,
        )
        ReactNativeBrownfield.initialize(application, options, onJSBundleLoaded)

        // The host is not a ReactApplication, so hand Hot Updater the brownfield
        // ReactHost: `hotUpdater.reload()` swaps the bundle on it and reloads.
        HotUpdater.setReactHost(ReactNativeBrownfield.shared.reactHost)
    }
}
