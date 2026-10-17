package com.hotupdater

import android.content.Context

/**
 * The native instance a TurboModule serves: the one whose bundle its React
 * Native runtime runs. Each runtime has its own module, so the runtimes of
 * two hosts each reach their own instance, and JavaScript needs no name.
 */
internal class HotUpdaterRuntimeInstance(
    private val context: Context,
    private val sourceURL: () -> String?,
    private val registry: HotUpdaterInstanceRegistry = HotUpdaterInstanceRegistry.shared,
    private val main: () -> HotUpdaterImpl = { HotUpdater.getInstance(context) },
) {
    @Volatile
    private var resolvedName: String? = null

    /**
     * Resolved on first use and kept, since a runtime runs one bundle until
     * it reloads, which creates a new module. JavaScript calls the module only
     * after its bundle loads; before that the runtime has no source URL, and
     * main serves without being kept.
     */
    val name: String
        get() {
            resolvedName?.let { return it }
            val url = sourceURL()?.takeIf { it.isNotEmpty() } ?: return HotUpdaterInstanceEnvironment.MAIN_NAME
            return registry.resolveName(context, url).also { resolvedName = it }
        }

    val impl: HotUpdaterImpl
        get() = impl(name)

    fun impl(name: String): HotUpdaterImpl = if (name == HotUpdaterInstanceEnvironment.MAIN_NAME) main() else registry.impl(name) ?: main()

    /**
     * Why [call] can't run, or null when it can. Reloading reaches main's
     * React host or restarts the app, so only main's runtime may until each
     * host reloads itself.
     */
    fun reloadUnsupportedReason(): String? {
        val name = name
        if (name == HotUpdaterInstanceEnvironment.MAIN_NAME) return null
        return RELOAD_UNSUPPORTED_MESSAGE
    }
}

/** The rejection code and message iOS uses too. */
internal const val RELOAD_UNSUPPORTED_CODE = "RELOAD_UNSUPPORTED"
internal const val RELOAD_UNSUPPORTED_MESSAGE =
    "HotUpdater.reload() and HotUpdater.reloadProcess() are not supported in a React Native runtime of a named " +
        "HotUpdaterInstance yet. Reload its React Native host from native code."
