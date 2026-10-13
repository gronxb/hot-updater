package com.hotupdaterexample

import android.app.Application
import android.os.Build
import com.hotupdaterexample.brownfield.ReactNativeHostManager

class MainApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Android also runs onCreate in other processes of the app, such as
        // the one Hot Updater restarts the app from; start React Native only
        // in the main one, as the brownfield guide does.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && getProcessName() != packageName) return
        ReactNativeHostManager.start(this)
    }
}
