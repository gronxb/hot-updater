package com.hotupdater

/**
 * Connects a host from the dev server form only while Home is idle. The form
 * can stay open as Home turns busy, so this asks at the tap, of the state then,
 * not of the state the form was drawn with.
 */
internal class HotUpdaterSandboxDevServerConnect(
    private val isBusy: () -> Boolean,
    private val connect: (String) -> Unit,
) {
    fun tap(host: String) {
        if (!isBusy()) connect(host)
    }
}

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
