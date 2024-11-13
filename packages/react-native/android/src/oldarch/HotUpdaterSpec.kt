package com.hotupdater

import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule

abstract class HotUpdaterSpec internal constructor(context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {

  abstract fun updateBundle(prefix: String, url: String?, callback: Callback)
  abstract fun reload()
  abstract fun initializeOnAppUpdate()
  abstract fun getAppVersion(callback: Callback)
  abstract fun getBundleTimestamp(callback: Callback)
}
