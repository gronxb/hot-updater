package com.hotupdater.lynx

/** A task can finish or report its own native runtime failure, never foreground readiness. */
internal class LynxBackgroundTask(
    val snapshot: LynxBackgroundSnapshot,
    private val host: LynxRuntimeHost,
) : AutoCloseable {
    /** Publish failure immediately; the engine still occupies its slot until native detach. */
    fun reportFatal(message: String) = host.finishBackground(snapshot.taskId, message, detached = false)
    override fun close() { host.finishBackground(snapshot.taskId, null, detached = true) }
}
