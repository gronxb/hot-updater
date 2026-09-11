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
        session.controller.setChannel(params.getString("channel"))
        session.controller.state(session)
    }
    @LynxMethod fun resetChannel(callback: Callback) = call(callback) { session ->
        JSONObject().put("reset", session.controller.resetChannel())
    }
    @LynxMethod fun clearCrashHistory(callback: Callback) = call(callback) { session ->
        session.controller.clearCrashHistory()
        session.controller.state(session)
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
    companion object {
        private val sessions = IdentityHashMap<Context, LynxLaunchSession>()
        internal fun bind(context: Context, session: LynxLaunchSession) { check(!sessions.containsKey(context)); sessions[context] = session }
        internal fun unbind(context: Context) { sessions.remove(context) }
    }
}
