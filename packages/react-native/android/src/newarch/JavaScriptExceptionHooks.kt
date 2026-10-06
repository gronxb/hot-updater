package com.hotupdater

import com.facebook.react.ReactApplication

/**
 * Routes JavaScript errors of the running React instance to crash recovery.
 * The New Architecture reaches the instance through ReactHost.
 */
internal object JavaScriptExceptionHooks {
    private val patchedReactHostDelegateIds = mutableSetOf<Int>()

    fun install(application: ReactApplication) {
        val reactHost = application.reactHost ?: return
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
