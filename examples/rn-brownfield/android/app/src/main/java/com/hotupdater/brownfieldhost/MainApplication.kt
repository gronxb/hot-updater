package com.hotupdater.brownfieldhost

import android.app.Application
import com.rnbrownfieldreact.ReactNativeHostManager

/**
 * Initializes the embedded React Native runtime once. `ReactNativeHostManager`
 * ships inside the rnbrownfieldreact AAR and loads the native libraries,
 * autolinked packages, and the React host.
 */
class MainApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        ReactNativeHostManager.initialize(this)
    }
}
