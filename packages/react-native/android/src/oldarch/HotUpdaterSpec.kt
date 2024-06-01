package com.hotupdater

import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReadableArray

abstract class HotUpdaterSpec internal constructor(context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {

  abstract fun updateBundle(prefix: String, urlStrings: ReadableArray, callback: Callback)
  abstract fun reload()
  abstract fun getAppVersion(callback: Callback)
  abstract fun getBundleVersion(callback: Callback)
}
