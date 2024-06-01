package com.hotupdater

import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray

class HotUpdaterModule internal constructor(context: ReactApplicationContext) :
    HotUpdaterSpec(context) {

  private val mReactApplicationContext: ReactApplicationContext = context

  override fun getName(): String {
    return NAME
  }

  @ReactMethod
  override fun reload() {
    HotUpdater.reload()
  }

  @ReactMethod
  override fun getAppVersion(callback: Callback) {
    try {
      val packageInfo =
          mReactApplicationContext.packageManager.getPackageInfo(
              mReactApplicationContext.packageName,
              0
          )

      callback.invoke(packageInfo.versionName)
    } catch (e: Exception) {
      callback.invoke(null)
    }
  }

  @ReactMethod
  override fun getBundleVersion(callback: Callback) {
    // test invoke
    callback.invoke(HotUpdater.getBundleVersion())
  }

  @ReactMethod
  override fun updateBundle(prefix: String, urlStrings: ReadableArray, callback: Callback) {
    val urlList = mutableListOf<String>()
    for (i in 0 until urlStrings.size()) {
      urlStrings.getString(i)?.let { urlList.add(it) }
    }
    val result = HotUpdater.updateBundle(prefix, urlList)
    callback.invoke(result)
  }

  companion object {
    const val NAME = "HotUpdater"
  }
}
