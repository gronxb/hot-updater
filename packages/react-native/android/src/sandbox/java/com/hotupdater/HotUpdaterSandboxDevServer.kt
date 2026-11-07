package com.hotupdater

/** A host the Dev server section lists. */
internal data class HotUpdaterSandboxDevServerHost(
    val address: String,
    /** Whether it answered, or null when nobody asked. */
    val isRunning: Boolean?,
)

/**
 * What the screen's Dev server section asks of the sandbox's dev-server mode.
 * Hosts are entered on the device, never taken from a link.
 */
internal interface HotUpdaterSandboxDevServer {
    /**
     * Whether this process runs JavaScript from a dev server. Read from the
     * sandbox process, never from `getBundleId()`, which can't say.
     */
    val isRunningDevServer: Boolean

    /** The host of the running session, when there is one. */
    val runningDevServerHost: String?

    val devServerHosts: List<HotUpdaterSandboxDevServerHost>

    /** What the last reload couldn't do. A failed connect says so to its completion. */
    val lastDevServerError: String?
        get() = null

    /** Called on the main thread when anything above changed. */
    var onDevServerChange: (() -> Unit)?

    /** Calls back on the main thread with what's wrong; success replaces this process. */
    fun connect(
        host: String,
        completion: (String?) -> Unit,
    )

    fun reloadDevServer()

    fun exitDevServer()
}
