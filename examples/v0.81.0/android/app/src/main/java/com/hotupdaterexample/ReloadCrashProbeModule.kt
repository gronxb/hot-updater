package com.hotupdaterexample

import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.atomic.AtomicInteger

class ReloadCrashProbeModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    override fun getName(): String = "ReloadCrashProbe"

    init {
        val creationIndex = creationCount.incrementAndGet()
        Log.w(TAG, "init creationIndex=$creationIndex")

        // Reproduce modules that emit to JS while reload is rebuilding the React instance.
        if (creationIndex > 1) {
            val isActiveAtInit = reactApplicationContext.hasActiveReactInstance()
            Thread {
                Log.w(
                    TAG,
                    "unsafe emit creationIndex=$creationIndex active=$isActiveAtInit",
                )

                if (!isActiveAtInit) {
                    throw IllegalStateException(
                        "Tried to access a JS module before the React instance was fully set up.",
                    )
                }

                val emitter =
                    reactApplicationContext.getJSModule(
                        DeviceEventManagerModule.RCTDeviceEventEmitter::class.java,
                    )
                emitter.emit("ReloadCrashProbe", creationIndex.toDouble())
            }.start()
        }
    }

    companion object {
        private const val TAG = "ReloadCrashProbe"
        private val creationCount = AtomicInteger(0)
    }
}
