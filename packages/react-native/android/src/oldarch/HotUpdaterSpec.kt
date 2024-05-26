package com.hotupdater

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.Callback

abstract class HotUpdaterSpec internal constructor(context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {

  abstract fun reload()
  abstract fun getAppVersion(callback: Callback)
  abstract fun getBundleVersion(callback: Callback)
}
