package com.hotupdater

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactMethod
import org.junit.Assert.assertTrue
import org.junit.Test

class HotUpdaterModuleBridgeTest {
    @Test
    fun `resetChannel is exported in old architecture`() {
        if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
            return
        }

        val method =
            HotUpdaterModule::class.java.getDeclaredMethod(
                "resetChannel",
                Promise::class.java,
            )

        assertTrue(method.isAnnotationPresent(ReactMethod::class.java))
    }
}
