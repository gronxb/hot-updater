package com.hotupdaterexample

import android.content.Intent
import android.os.Bundle
import android.util.TypedValue
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.appcompat.app.AppCompatActivity
import com.callstack.reactnativebrownfield.ReactNativeBrownfield
import com.callstack.reactnativebrownfield.ReactNativeFragment
import com.hotupdaterexample.brownfield.HotUpdaterWidgetHost
import com.hotupdaterexample.brownfield.ReactNativeHostManager

/**
 * A native screen that shows the example's React Native root on every launch,
 * as the E2E scenarios expect.
 */
class MainActivity : AppCompatActivity() {
    private var reactNativeStarted = false

    /** The second instance's strip under the example, when a scenario turns it on. */
    private var widgetContainer: FrameLayout? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        // Start without restored fragments, as a ReactActivity does: a React
        // Native screen does not survive its process, and Hot Updater
        // restarts the process to apply or roll back a bundle.
        super.onCreate(null)
        val reactNativeRoot = FrameLayout(this).apply { id = R.id.react_native_root }
        if (HotUpdaterWidgetHost.isEnabled(this)) {
            val widget = FrameLayout(this).also { widgetContainer = it }
            setContentView(
                LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    addView(reactNativeRoot, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
                    addView(widget, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(WIDGET_HEIGHT_DP)))
                },
            )
        } else {
            setContentView(reactNativeRoot)
        }
        ReactNativeHostManager.whenStarted {
            reactNativeStarted = true
            showReactNative()
        }
        // The widget's runtime starts after the example's bundle has loaded.
        widgetContainer?.let { container ->
            ReactNativeHostManager.whenBundleLoaded {
                if (isFinishing || isDestroyed || container.childCount > 0) return@whenBundleLoaded
                HotUpdaterWidgetHost.createView(this)?.let { container.addView(it) }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        HotUpdaterWidgetHost.onResume(this)
    }

    override fun onPause() {
        HotUpdaterWidgetHost.onPause(this)
        super.onPause()
    }

    override fun onDestroy() {
        widgetContainer?.removeAllViews()
        HotUpdaterWidgetHost.onDestroy(this)
        super.onDestroy()
    }

    private fun dp(value: Int): Int =
        TypedValue
            .applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics)
            .toInt()

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
        // The launch intent stays the activity's, as with a ReactActivity, so
        // JavaScript reads the cold-start link as the initial URL. React
        // Native's host drops an intent that arrives before its bundle loads,
        // so every later link waits for it, in order.
        ReactNativeHostManager.whenBundleLoaded {
            ReactNativeBrownfield.shared.reactHost.onNewIntent(intent)
        }
    }
}

private const val WIDGET_HEIGHT_DP = 132
