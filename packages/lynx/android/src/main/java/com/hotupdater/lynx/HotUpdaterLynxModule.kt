package com.hotupdater.lynx

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.lynx.jsbridge.LynxMethod
import com.lynx.jsbridge.LynxModule
import com.lynx.react.bridge.Callback
import com.lynx.react.bridge.ReadableMap
import com.lynx.react.bridge.JavaOnlyMap
import com.lynx.react.bridge.JavaOnlyArray
import java.util.IdentityHashMap
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Framework-independent background native bridge; never accepts context or attempt IDs. */
class HotUpdaterLynxModule(context: Context) : LynxModule(context) {
    @LynxMethod fun getState(callback: Callback) = call(callback) { session -> session.controller.state(session) }
    @LynxMethod fun acceptCatalog(params: ReadableMap, callback: Callback) = call(callback) { session -> session.controller.accept(session, json(params)) }
    @LynxMethod fun prepareSelection(params: ReadableMap, callback: Callback) = call(callback) { session -> session.controller.prepare(session, json(params)) }
    @LynxMethod fun stageSelection(params: ReadableMap, callback: Callback) = call(callback) { session -> session.controller.stage(session, json(params).getString("preparedId")) }
    @LynxMethod fun setCohort(params: ReadableMap, callback: Callback) = call(callback) { session ->
        session.controller.setCohort(params.getString("cohort"))
        session.controller.state(session)
    }
    @LynxMethod fun setChannel(params: ReadableMap, callback: Callback) = call(callback) { session ->
        val channel = json(params).getString("channel")
        session.controller.setChannel(channel)
        session.controller.state(session)
    }
    @LynxMethod fun resetChannel(callback: Callback) = call(callback) { session ->
        JSONObject().put("reset", session.controller.resetChannel())
    }
    @LynxMethod fun clearCrashHistory(callback: Callback) = call(callback) { session ->
        session.controller.clearCrashHistory()
        session.controller.state(session)
    }
    @LynxMethod fun reload(callback: Callback) {
        reply(callback, Result.success(JSONObject()))
        Handler(Looper.getMainLooper()).post {
            val context = mContext as android.content.Context
            val applicationContext = context.applicationContext
            try {
                android.util.Log.i("HotUpdaterImpl", "Started restart trampoline to apply update bundle")
                val activity = activityOf(context)
                val relaunch = relaunchIntent(applicationContext, activity)
                val restartIntent = android.content.Intent(
                    applicationContext,
                    HotUpdaterRestartActivity::class.java,
                ).apply {
                    addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                    addFlags(android.content.Intent.FLAG_ACTIVITY_NO_ANIMATION)
                    putExtra(HotUpdaterRestartActivity.EXTRA_PACKAGE_NAME, applicationContext.packageName)
                    putExtra(HotUpdaterRestartActivity.EXTRA_TARGET_PID, android.os.Process.myPid())
                    if (relaunch != null) {
                        putExtra(HotUpdaterRestartActivity.EXTRA_RELAUNCH_INTENT, relaunch)
                    }
                }
                if (activity != null) {
                    val options = android.app.ActivityOptions.makeCustomAnimation(activity, 0, 0)
                    activity.startActivity(restartIntent, options.toBundle())
                } else {
                    applicationContext.startActivity(restartIntent)
                }
            } catch (error: Exception) {
                android.util.Log.w("HotUpdaterImpl", "Failed to start restart trampoline", error)
                val intent = relaunchIntent(applicationContext, activityOf(context))
                    ?: applicationContext.packageManager.getLaunchIntentForPackage(
                        applicationContext.packageName,
                    )
                intent?.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                if (intent != null) applicationContext.startActivity(intent)
                android.util.Log.i("HotUpdaterImpl", "Started restart trampoline to apply update bundle")
                android.os.Process.killProcess(android.os.Process.myPid())
            }
        }
    }
    @LynxMethod fun notifyAppReady(callback: Callback) {
        Handler(Looper.getMainLooper()).post {
            val session = sessions[mContext]
            if (session == null) reply(callback, Result.failure(CatalogPolicy.Rejected("NO_CONTEXT", "No registered native context")))
            else session.notifyReady { result -> if (session.live) reply(callback, result) }
        }
    }
    private fun call(callback: Callback, operation: suspend (LynxLaunchSession) -> JSONObject) {
        Handler(Looper.getMainLooper()).post {
            val session = sessions[mContext]
            if (session == null) reply(callback, Result.failure(CatalogPolicy.Rejected("NO_CONTEXT", "No registered native context")))
            else session.scope.launch { val result = runCatching { operation(session) }; if (session.live) reply(callback, result) }
        }
    }
    private fun json(map: ReadableMap) = JSONObject(map.asHashMap())
    private fun reply(callback: Callback, result: Result<JSONObject>) {
        val envelope = result.fold(
            { JSONObject().put("ok", true).put("data", it) },
            { error -> JSONObject().put("ok", false).put("error", JSONObject()
                .put("code", when (error) { is CatalogPolicy.Rejected -> error.code; is LynxIncompatibleArtifactException -> "INCOMPATIBLE"; else -> "NATIVE_ERROR" })
                .put("message", error.message ?: "Native operation failed")) },
        )
        callback.invoke(toMap(envelope))
    }
    private fun toMap(value: JSONObject): JavaOnlyMap = JavaOnlyMap.from(value.keys().asSequence().associateWith { key -> toBridge(value.get(key)) })
    private fun toBridge(value: Any): Any? = when (value) {
        JSONObject.NULL -> null
        is JSONObject -> toMap(value)
        is org.json.JSONArray -> JavaOnlyArray.from((0 until value.length()).map { index -> toBridge(value.get(index)) })
        else -> value
    }
    private fun activityOf(context: android.content.Context): android.app.Activity? {
        var current: android.content.Context? = context
        while (current is android.content.ContextWrapper) {
            if (current is android.app.Activity) return current
            current = current.baseContext
        }
        return current as? android.app.Activity
    }
    private fun relaunchIntent(
        applicationContext: android.content.Context,
        activity: android.app.Activity?,
    ): android.content.Intent? {
        if (activity != null) {
            val component = activity.componentName
            return android.content.Intent.makeRestartActivityTask(component).apply {
                activity.intent.extras?.let(::putExtras)
                addFlags(android.content.Intent.FLAG_ACTIVITY_NO_ANIMATION)
            }
        }
        return applicationContext.packageManager.getLaunchIntentForPackage(applicationContext.packageName)
    }
    companion object {
        private val sessions = IdentityHashMap<Context, LynxLaunchSession>()
        internal fun bind(context: Context, session: LynxLaunchSession) { check(!sessions.containsKey(context)); sessions[context] = session }
        internal fun unbind(context: Context) { sessions.remove(context) }
    }
}
