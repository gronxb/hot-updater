package com.hotupdater.brownfieldhost

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import com.callstack.reactnativebrownfield.ReactNativeBrownfield

/**
 * Renders the `RnBrownfield` root component (registered in the React Native
 * project's index.js) full-screen.
 *
 * `popToNative()` from JavaScript, and the hardware back button once the
 * JavaScript side has nothing left to pop, go through this activity's
 * `onBackPressedDispatcher`, which finishes it and returns to [MainActivity].
 */
class ReactNativeActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val launchOptions = Bundle().apply {
            putString("host", "BrownfieldHost (Android)")
        }
        val reactView = ReactNativeBrownfield.shared.createView(
            activity = this,
            moduleName = "RnBrownfield",
            launchOptions = launchOptions,
        )
        setContentView(reactView)
    }
}
