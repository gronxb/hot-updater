package com.hotupdater.lynxexample

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.lynx.jsbridge.LynxMethod
import com.lynx.jsbridge.LynxModule
import com.lynx.react.bridge.Callback
import com.lynx.react.bridge.JavaOnlyMap
import java.util.IdentityHashMap

internal class LaunchAttempt(val data: Map<String, Any>, val resources: ReleaseResources, val requiresFont: Boolean, val journal: StartupState, val selection: Selection, val readyDelayMs: Long) {
    var observedContent = false
    var live = true
    var failed = false
    var confirmed = false
    private val readyCallbacks = mutableListOf<Callback>()
    fun ready(callback: Callback) {
        if (!live || failed) { callback.invoke(error("STALE_CONTEXT", "The startup context is no longer eligible")); return }
        readyCallbacks.add(callback)
        confirmIfReady()
    }
    fun confirmIfReady() {
        if (!observedContent || !live || failed || readyCallbacks.isEmpty()) return
        if (requiresFont && !resources.fontLoaded) {
            Log.i("HotUpdaterLynxG1", "ready-awaits-native-font $data")
            return
        }
        if (!confirmed) {
            val committed = runCatching { journal.confirm(selection, data["attemptId"].toString()) }.isSuccess
            if (!committed) {
                readyCallbacks.toList().also { readyCallbacks.clear() }.forEach { it.invoke(error("PERSISTENCE_FAILED", "Could not persist confirmation")) }
                return
            }
            confirmed = true
            Log.i("HotUpdaterLynxG1", "confirmed $data")
        }
        readyCallbacks.toList().also { readyCallbacks.clear() }.forEach { it.invoke(success(mapOf("confirmed" to true))) }
    }
}

internal object SpikeRegistry {
    var resources: ReleaseResources? = null
    var recovered = false
    var primaryStarted = false
    val attempts = IdentityHashMap<Context, LaunchAttempt>()
}
internal fun success(data: Map<String, Any>): JavaOnlyMap = JavaOnlyMap().apply { putBoolean("ok", true); putMap("data", JavaOnlyMap.from(data)) }
internal fun error(code: String, message: String): JavaOnlyMap = JavaOnlyMap().apply { putBoolean("ok", false); putMap("error", JavaOnlyMap.from(mapOf("code" to code, "message" to message))) }

/** Private feasibility API. Native's context object supplies readiness authority. */
class SpikeModule(context: Context) : LynxModule(context) {
    @LynxMethod fun getLaunchInfo(callback: Callback) {
        Handler(Looper.getMainLooper()).post {
            val attempt = SpikeRegistry.attempts[mContext]
            Log.i("HotUpdaterLynxG1", "getLaunchInfo context=${System.identityHashCode(mContext)} bound=${attempt != null}")
            callback.invoke(if (attempt != null && attempt.live) success(attempt.data) else error("NO_CONTEXT", "No live primary context"))
        }
    }
    @LynxMethod fun notifyReady(callback: Callback) {
        Handler(Looper.getMainLooper()).post {
            val attempt = SpikeRegistry.attempts[mContext]
            Log.i("HotUpdaterLynxG1", "notifyReady context=${System.identityHashCode(mContext)} bound=${attempt != null}")
            if (attempt == null) callback.invoke(error("NO_CONTEXT", "No live primary context"))
            else if (attempt.readyDelayMs > 0) {
                Log.i("HotUpdaterLynxG1", "ready-delay-enqueued attempt=${attempt.data["attemptId"]} delayMs=${attempt.readyDelayMs}")
                Handler(Looper.getMainLooper()).postDelayed({
                    if (!attempt.live) Log.i("HotUpdaterLynxG1", "stale-context-rejected attempt=${attempt.data["attemptId"]}")
                    else attempt.ready(callback)
                }, attempt.readyDelayMs)
            } else attempt.ready(callback)
        }
    }
    @LynxMethod fun probeError(callback: Callback) {
        Handler(Looper.getMainLooper()).post {
            Log.i("HotUpdaterLynxG1", "probeError context=${System.identityHashCode(mContext)}")
            callback.invoke(error("G1_EXPECTED_ERROR", "Expected asynchronous native error"))
        }
    }
}
