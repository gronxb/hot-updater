package com.hotupdater.brownfieldhost

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import com.callstack.reactnativebrownfield.ReactNativeBrownfield

/**
 * Renders the `RnBrownfield` root component (registered in the React Native
 * project's index.js) full-screen.
 */
class MainActivity : AppCompatActivity() {
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
