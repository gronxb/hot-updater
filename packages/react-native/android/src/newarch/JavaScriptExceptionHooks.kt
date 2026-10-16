package com.hotupdater

import android.content.Context
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.bridge.ReactContext

/**
 * Routes JavaScript errors of the running React instance to crash recovery.
 * The New Architecture reaches the instance through ReactHost: the one a
 * brownfield app passes to `HotUpdater.setReactHost`, the application's, or
 * the host of a runtime whose HotUpdater module was created. An error belongs
 * to the instance whose bundle the host's runtime runs.
 */
internal object JavaScriptExceptionHooks {
    private val patchedReactHostDelegateIds = mutableSetOf<Int>()

    fun install(appContext: Context) {
        val reactHost =
            ReactHostHolder.getReactHost()
                ?: (appContext as? ReactApplication)?.reactHost
                ?: return
        patchReactHost(reactHost)
    }

    /**
     * Hooks the host of [reactContext]'s runtime. Without a bridge, a fatal
     * error reaches only the host's delegate, and the host of a named
     * instance's runtime is reached only through its context.
     */
    fun installForRuntime(reactContext: ReactContext) {
        HotUpdaterRecoveryManager.patchReactContextExceptionHandler(reactContext)
        // BridgelessReactContext's host: `mReactHost` before React Native 0.80's Kotlin rewrite.
        val reactHost =
            listOf("reactHost", "mReactHost")
                .firstNotNullOfOrNull { name -> HotUpdaterRecoveryManager.findField(reactContext.javaClass, name) }
                ?.let { field ->
                    field.isAccessible = true
                    field.get(reactContext)
                } as? ReactHost ?: return
        patchReactHost(reactHost)
    }

    private fun patchReactHost(reactHost: ReactHost) {
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
        val patches = synchronized(this) { patchedReactHostDelegateIds.add(delegateIdentity) }
        if (patches) {
            val exceptionHandlerField =
                HotUpdaterRecoveryManager.findField(reactHostDelegate.javaClass, "exceptionHandler")
            if (exceptionHandlerField == null) {
                synchronized(this) { patchedReactHostDelegateIds.remove(delegateIdentity) }
                return
            }

            exceptionHandlerField.isAccessible = true
            @Suppress("UNCHECKED_CAST")
            val previousHandler =
                exceptionHandlerField.get(reactHostDelegate) as? (Exception) -> Unit

            exceptionHandlerField.set(reactHostDelegate) { exception: Exception ->
                // The host still holds the runtime that failed: it tears it down after the delegate.
                val sourceURL = runCatching { reactHost.currentReactContext?.sourceURL }.getOrNull()
                if (!HotUpdaterRecoveryManager.handleJavaScriptExceptionForRecovery(exception, sourceURL)) {
                    previousHandler?.invoke(exception) ?: throw exception
                }
            }
        }

        reactHost.currentReactContext?.let(HotUpdaterRecoveryManager::patchReactContextExceptionHandler)
    }
}
