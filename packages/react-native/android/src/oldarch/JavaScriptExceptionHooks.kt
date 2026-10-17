package com.hotupdater

import android.content.Context
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.JSExceptionHandler
import com.facebook.react.bridge.ReactContext

/**
 * Routes JavaScript errors of the running React instance to crash recovery.
 * The old architecture reaches the instance through ReactNativeHost, which only
 * an old architecture build compiles, or through the context of a runtime
 * whose HotUpdater module was created. An error belongs to the instance whose
 * bundle the runtime runs.
 */
internal object JavaScriptExceptionHooks {
    private val patchedInstanceManagers = WeakIdentitySet<Any>()
    private val patchedCatalystInstances = WeakIdentitySet<Any>()

    fun install(appContext: Context) {
        val application = appContext as? ReactApplication ?: return
        val instanceManager = application.reactNativeHost.reactInstanceManager
        if (patchedInstanceManagers.add(instanceManager)) {
            val exceptionHandlerField =
                HotUpdaterRecoveryManager.findField(instanceManager.javaClass, "mJSExceptionHandler")
            if (exceptionHandlerField == null) {
                patchedInstanceManagers.remove(instanceManager)
                return
            }

            exceptionHandlerField.isAccessible = true
            val previousHandler = exceptionHandlerField.get(instanceManager) as? JSExceptionHandler
            exceptionHandlerField.set(
                instanceManager,
                HotUpdaterRecoveryManager.RecoveryJSExceptionHandler(
                    previousHandler,
                    { instanceManager.currentReactContext?.sourceURL },
                    { instanceManager.currentReactContext },
                ),
            )
        }

        instanceManager.currentReactContext?.let(::installForRuntime)
    }

    /** Hooks the catalyst instance of [reactContext]'s runtime, which a named instance's runtime is reached through. */
    fun installForRuntime(reactContext: ReactContext) {
        HotUpdaterRecoveryManager.patchReactContextExceptionHandler(reactContext)
        patchCatalystInstanceExceptionHandler(reactContext)
    }

    private fun patchCatalystInstanceExceptionHandler(reactContext: ReactContext) {
        val catalystInstance =
            try {
                reactContext.catalystInstance
            } catch (_: Exception) {
                null
            } ?: return

        if (!patchedCatalystInstances.add(catalystInstance)) {
            return
        }

        val exceptionHandlerField =
            HotUpdaterRecoveryManager.findField(catalystInstance.javaClass, "mJSExceptionHandler")
        if (exceptionHandlerField == null) {
            patchedCatalystInstances.remove(catalystInstance)
            return
        }

        exceptionHandlerField.isAccessible = true
        val previousHandler = exceptionHandlerField.get(catalystInstance) as? JSExceptionHandler
        if (previousHandler is HotUpdaterRecoveryManager.RecoveryJSExceptionHandler) {
            return
        }
        exceptionHandlerField.set(
            catalystInstance,
            HotUpdaterRecoveryManager.RecoveryJSExceptionHandler(previousHandler, { catalystInstance.sourceURL }, { reactContext }),
        )
    }
}
