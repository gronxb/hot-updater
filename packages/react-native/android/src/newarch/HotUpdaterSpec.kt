package com.hotupdater

import com.facebook.react.bridge.ReactApplicationContext

abstract class HotUpdaterSpec internal constructor(context: ReactApplicationContext) :
  NativeHotUpdaterSpec(context) {
}
