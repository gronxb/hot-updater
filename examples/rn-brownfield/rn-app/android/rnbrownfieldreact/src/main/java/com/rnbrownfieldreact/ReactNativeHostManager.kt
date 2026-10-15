package com.rnbrownfieldreact

import android.app.Application
import com.callstack.reactnativebrownfield.OnJSBundleLoaded
import com.callstack.reactnativebrownfield.ReactNativeBrownfield
import com.facebook.react.PackageList
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.ReactContext
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
        val reactHost = ReactNativeBrownfield.shared.reactHost
        HotUpdater.setReactHost(reactHost)

        // That reload restarts the surface the host's activity already shows.
        // React Native reports first content only for a surface it creates, and
        // Hot Updater completes a launch on that report (until then `wrap` keeps
        // its fallback up, and the next process start rolls the bundle back).
        // Recreate the activity once the reloaded instance is ready, so its new
        // view gets a new surface.
        reactHost.addReactInstanceEventListener(object : ReactInstanceEventListener {
            private var initialInstance = true

            override fun onReactContextInitialized(context: ReactContext) {
                if (initialInstance) {
                    initialInstance = false
                    return
                }
                val activity = context.currentActivity ?: return
                activity.runOnUiThread { activity.recreate() }
            }
        })
    }
}
