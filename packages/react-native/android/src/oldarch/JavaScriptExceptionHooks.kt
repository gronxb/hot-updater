package com.hotupdater

import com.facebook.react.ReactApplication
import com.facebook.react.bridge.JSExceptionHandler
import com.facebook.react.bridge.ReactContext

/**
 * Routes JavaScript errors of the running React instance to crash recovery.
 * The old architecture reaches the instance through ReactNativeHost, which only
 * an old architecture build compiles.
 */
internal object JavaScriptExceptionHooks {
    private val patchedInstanceManagerIds = mutableSetOf<Int>()
    private val patchedCatalystInstanceIds = mutableSetOf<Int>()

    fun install(application: ReactApplication) {
        val instanceManager = application.reactNativeHost.reactInstanceManager
        val managerIdentity = System.identityHashCode(instanceManager)
        if (patchedInstanceManagerIds.add(managerIdentity)) {
            val exceptionHandlerField =
                HotUpdaterRecoveryManager.findField(instanceManager.javaClass, "mJSExceptionHandler")
            if (exceptionHandlerField == null) {
                patchedInstanceManagerIds.remove(managerIdentity)
                return
            }

            exceptionHandlerField.isAccessible = true
            val previousHandler = exceptionHandlerField.get(instanceManager) as? JSExceptionHandler
            exceptionHandlerField.set(
                instanceManager,
                HotUpdaterRecoveryManager.RecoveryJSExceptionHandler(previousHandler),
            )
        }

        instanceManager.currentReactContext?.let { reactContext ->
            HotUpdaterRecoveryManager.patchReactContextExceptionHandler(reactContext)
            patchCatalystInstanceExceptionHandler(reactContext)
        }
    }

    private fun patchCatalystInstanceExceptionHandler(reactContext: ReactContext) {
        val catalystInstance =
            try {
                reactContext.catalystInstance
            } catch (_: Exception) {
                null
            } ?: return

        val catalystIdentity = System.identityHashCode(catalystInstance)
        if (!patchedCatalystInstanceIds.add(catalystIdentity)) {
            return
        }

        val exceptionHandlerField =
            HotUpdaterRecoveryManager.findField(catalystInstance.javaClass, "mJSExceptionHandler")
        if (exceptionHandlerField == null) {
            patchedCatalystInstanceIds.remove(catalystIdentity)
            return
        }

        exceptionHandlerField.isAccessible = true
        val previousHandler = exceptionHandlerField.get(catalystInstance) as? JSExceptionHandler
        if (previousHandler is HotUpdaterRecoveryManager.RecoveryJSExceptionHandler) {
            return
        }
        exceptionHandlerField.set(
            catalystInstance,
            HotUpdaterRecoveryManager.RecoveryJSExceptionHandler(previousHandler),
        )
    }
}
