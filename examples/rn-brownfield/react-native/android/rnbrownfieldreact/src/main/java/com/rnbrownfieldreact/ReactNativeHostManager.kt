package com.rnbrownfieldreact

import android.app.Application
import com.callstack.reactnativebrownfield.OnJSBundleLoaded
import com.callstack.reactnativebrownfield.ReactNativeBrownfield
import com.facebook.react.PackageList

/**
 * Entry point for host apps: call `initialize` once from `Application.onCreate`.
 * `ReactNativeBrownfield.initialize` loads the React Native native libraries
 * itself, so the host must not call `loadReactNative` as well: doing both
 * overrides React Native's feature flags twice and crashes at startup.
 */
object ReactNativeHostManager {
    fun initialize(application: Application, onJSBundleLoaded: OnJSBundleLoaded? = null) {
        val packageList = PackageList(application).packages
        ReactNativeBrownfield.initialize(application, packageList, onJSBundleLoaded)
    }
}
