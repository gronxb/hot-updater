package com.hotupdater

import android.content.Context
import android.view.View
import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.CatalystInstance
import com.facebook.react.bridge.JavaScriptContextHolder
import com.facebook.react.bridge.JavaScriptModule
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UIManager
import com.facebook.react.turbomodule.core.interfaces.CallInvokerHolder
import java.lang.reflect.Proxy

/**
 * A bridgeless runtime that loaded its bundle from [sourceURL], whose UI
 * manager holds the root views [rootViews] returns by root tag.
 */
internal class TestReactContext(
    base: Context,
    private val sourceURL: String?,
    private val rootViews: (Int) -> View?,
) : ReactContext(base) {
    private val uiManager =
        Proxy.newProxyInstance(UIManager::class.java.classLoader, arrayOf(UIManager::class.java)) { proxy, method, args ->
            when (method.name) {
                "resolveView" -> rootViews(args[0] as Int)
                "hashCode" -> System.identityHashCode(proxy)
                "equals" -> proxy === args[0]
                "toString" -> "TestUIManager"
                else -> null
            }
        } as UIManager

    override fun isBridgeless(): Boolean = true

    override fun getFabricUIManager(): UIManager = uiManager

    override fun getSourceURL(): String? = sourceURL

    override fun <T : JavaScriptModule> getJSModule(jsInterface: Class<T>): T = throw UnsupportedOperationException()

    override fun <T : NativeModule> hasNativeModule(nativeModuleInterface: Class<T>): Boolean = false

    override fun getNativeModules(): Collection<NativeModule> = emptyList()

    override fun <T : NativeModule> getNativeModule(nativeModuleInterface: Class<T>): T = throw UnsupportedOperationException()

    override fun getNativeModule(moduleName: String): NativeModule? = null

    override fun getCatalystInstance(): CatalystInstance = throw UnsupportedOperationException()

    override fun hasActiveCatalystInstance(): Boolean = false

    override fun hasActiveReactInstance(): Boolean = true

    override fun hasCatalystInstance(): Boolean = false

    override fun hasReactInstance(): Boolean = true

    override fun destroy() = Unit

    override fun handleException(e: Exception) = Unit

    override fun getJavaScriptContextHolder(): JavaScriptContextHolder? = null

    override fun getJSCallInvokerHolder(): CallInvokerHolder? = null

    override fun registerSegment(
        segmentId: Int,
        path: String,
        callback: Callback,
    ) = Unit
}
