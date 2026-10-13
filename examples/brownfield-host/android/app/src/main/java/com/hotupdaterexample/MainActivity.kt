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
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val container = FrameLayout(this).apply { id = R.id.react_native_root }
        setContentView(container)
        if (savedInstanceState == null) {
            ReactNativeHostManager.whenStarted {
                if (!isFinishing && !supportFragmentManager.isStateSaved) {
                    supportFragmentManager
                        .beginTransaction()
                        .replace(container.id, ReactNativeFragment.createReactNativeFragment("HotUpdaterExample"))
                        .commitNow()
                }
            }
        }
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
