package com.hotupdater

import android.content.Context
import com.facebook.react.ReactApplication

/**
 * Routes JavaScript errors of the running React instance to crash recovery.
 * The New Architecture reaches the instance through ReactHost: the one a
 * brownfield app passes to `HotUpdater.setReactHost`, or the application's.
 */
internal object JavaScriptExceptionHooks {
    private val patchedReactHostDelegateIds = mutableSetOf<Int>()

    fun install(appContext: Context) {
        val reactHost =
            ReactHostHolder.getReactHost()
                ?: (appContext as? ReactApplication)?.reactHost
                ?: return
        val reactHostDelegate =
            HotUpdaterRecoveryManager.findField(reactHost.javaClass, "mReactHostDelegate")?.let { field ->
                field.isAccessible = true
                field.get(reactHost)
            }
                ?: HotUpdaterRecoveryManager.findField(reactHost.javaClass, "reactHostDelegate")?.let { field ->
                    field.isAccessible = true
                    field.get(reactHost)
                }
                ?: return

        val delegateIdentity = System.identityHashCode(reactHostDelegate)
        if (patchedReactHostDelegateIds.add(delegateIdentity)) {
            val exceptionHandlerField =
                HotUpdaterRecoveryManager.findField(reactHostDelegate.javaClass, "exceptionHandler")
            if (exceptionHandlerField == null) {
                patchedReactHostDelegateIds.remove(delegateIdentity)
                return
            }

            exceptionHandlerField.isAccessible = true
            @Suppress("UNCHECKED_CAST")
            val previousHandler =
                exceptionHandlerField.get(reactHostDelegate) as? (Exception) -> Unit

            exceptionHandlerField.set(reactHostDelegate) { exception: Exception ->
                if (!HotUpdaterRecoveryManager.handleJavaScriptExceptionForRecovery(exception)) {
                    previousHandler?.invoke(exception) ?: throw exception
                }
            }
        }

        reactHost.currentReactContext?.let(HotUpdaterRecoveryManager::patchReactContextExceptionHandler)
    }
}
