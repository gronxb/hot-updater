package com.hotupdaterexample

import android.app.Application
import com.hotupdaterexample.brownfield.ReactNativeHostManager

class MainApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        ReactNativeHostManager.start(this)
    }
}
