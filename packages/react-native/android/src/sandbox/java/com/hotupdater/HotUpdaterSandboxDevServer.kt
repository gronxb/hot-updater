package com.hotupdater

import android.os.Build

/** A host the Dev server section lists. */
internal data class HotUpdaterSandboxDevServerHost(
    val address: String,
    /** Whether it answered, or null when nobody asked. */
    val isRunning: Boolean?,
)

/**
 * What the screen's Dev server section asks of the sandbox's dev-server mode.
 * Hosts are entered on the device, never taken from a link. Everything here runs
 * on the main thread.
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

    /** Called when [devServerHosts] or the running session changed. */
    var onDevServerChange: (() -> Unit)?

    /** Calls back with null once connected, or with what's wrong. */
    fun connect(
        host: String,
        completion: (String?) -> Unit,
    )

    fun reloadDevServer()

    fun exitDevServer()
}

/**
 * The default until dev-server mode is in this build: it lists the address an
 * emulator would use, and says so when asked to connect.
 */
internal class HotUpdaterSandboxNoDevServer : HotUpdaterSandboxDevServer {
    override var onDevServerChange: (() -> Unit)? = null
    override val isRunningDevServer = false
    override val runningDevServerHost: String? = null

    override val devServerHosts: List<HotUpdaterSandboxDevServerHost>
        get() =
            if (Build.FINGERPRINT.contains("generic") || Build.PRODUCT.contains("sdk")) {
                listOf(HotUpdaterSandboxDevServerHost("10.0.2.2:8081", null))
            } else {
                emptyList()
            }

    override fun connect(
        host: String,
        completion: (String?) -> Unit,
    ) {
        completion("This build can't run JavaScript from a dev server yet.")
    }

    override fun reloadDevServer() = Unit

    override fun exitDevServer() = Unit
}
