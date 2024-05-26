package com.hotupdater

import android.util.Log

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Callback

class HotUpdaterModule internal constructor(context: ReactApplicationContext) :
  HotUpdaterSpec(context) {

  override fun getName(): String {
    return NAME
  }

  // Example method
  // See https://reactnative.dev/docs/native-modules-android
  @ReactMethod
  override fun reload() {
    // test log
    Log.d("HotUpdater", "HotUpdater requested a reload")
  }


  @ReactMethod
  override fun getAppVersion(callback: Callback) {
    try {
      val packageInfo = reactApplicationContext.packageManager.getPackageInfo(reactApplicationContext.packageName, 0)
      callback.invoke(packageInfo.versionName)
    } catch (e: Exception) {
      callback.invoke(null)
    }
  }

  @ReactMethod
  override fun getBundleVersion(callback: Callback) {
    // test invoke
    callback.invoke(2)
  }

  companion object {
    const val NAME = "HotUpdater"
  }
}
