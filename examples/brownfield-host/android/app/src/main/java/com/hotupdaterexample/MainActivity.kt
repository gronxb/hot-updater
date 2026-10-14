package com.hotupdaterexample

import android.content.Intent
import android.os.Bundle
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import com.callstack.reactnativebrownfield.ReactNativeBrownfield
import com.callstack.reactnativebrownfield.ReactNativeFragment
import com.hotupdaterexample.brownfield.ReactNativeHostManager

/**
 * A native screen that shows the example's React Native root on every launch,
 * as the E2E scenarios expect.
 */
class MainActivity : AppCompatActivity() {
    private var reactNativeStarted = false

    override fun onCreate(savedInstanceState: Bundle?) {
        // Start without restored fragments, as a ReactActivity does: a React
        // Native screen does not survive its process, and Hot Updater
        // restarts the process to apply or roll back a bundle.
        super.onCreate(null)
        setContentView(FrameLayout(this).apply { id = R.id.react_native_root })
        ReactNativeHostManager.whenStarted {
            reactNativeStarted = true
            showReactNative()
        }
    }

    // React Native can finish starting after this screen saved its state, when
    // no fragment can be added; it is added when the screen resumes.
    override fun onPostResume() {
        super.onPostResume()
        showReactNative()
    }

    private fun showReactNative() {
        val fragments = supportFragmentManager
        if (!reactNativeStarted || isFinishing || isDestroyed || fragments.isStateSaved) return
        if (fragments.findFragmentById(R.id.react_native_root) != null) return
        fragments
            .beginTransaction()
            .replace(R.id.react_native_root, ReactNativeFragment.createReactNativeFragment("HotUpdaterExample"))
            .commitNow()
    }

    // A ReactActivity hands new deep links to React Native; a native screen
    // that hosts a ReactNativeFragment has to do it itself.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        ReactNativeHostManager.whenStarted {
            ReactNativeBrownfield.shared.reactHost.onNewIntent(intent)
        }
    }
}
