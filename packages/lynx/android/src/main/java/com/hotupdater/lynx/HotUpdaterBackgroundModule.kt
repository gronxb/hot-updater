package com.hotupdater.lynx

import android.content.Context
import com.lynx.jsbridge.IModuleCreator
import com.lynx.jsbridge.LynxMethod
import com.lynx.jsbridge.LynxModule
import com.lynx.jsbridge.LynxModuleWrapper
import com.lynx.jsbridge.ParamWrapper
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

internal fun interface LynxBackgroundCompletionSink {
    fun complete(value: String)
}

/** The native-created parameter binds completion to one task; JS supplies only its output. */
class HotUpdaterBackgroundModule(context: Context, parameter: Any) : LynxModule(context, parameter) {
    private val sink = parameter as LynxBackgroundCompletionSink
    private val completed = AtomicBoolean()

    @LynxMethod fun complete(value: String) {
        if (completed.compareAndSet(false, true)) sink.complete(value)
    }

    internal companion object {
        const val NAME = "HotUpdaterBackground"
    }
}

/** CommonModuleCreator otherwise falls back to LynxEnv's application-wide registrations. */
internal class LynxBackgroundModuleCreator(
    private val delegate: IModuleCreator,
) : IModuleCreator by delegate {
    override fun create(name: String, wrappers: ConcurrentHashMap<String, ParamWrapper>): LynxModuleWrapper? =
        if (name == HotUpdaterBackgroundModule.NAME) delegate.create(name, wrappers) else null
}
