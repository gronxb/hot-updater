package com.hotupdater.lynx

/** A task can finish or report its own native runtime failure, never foreground readiness. */
internal class LynxBackgroundTask(
    val snapshot: LynxBackgroundSnapshot,
    private val host: LynxRuntimeHost,
) : AutoCloseable {
    fun fail(message: String) = host.finishBackground(snapshot.taskId, message)
    override fun close() { host.finishBackground(snapshot.taskId, null) }
}
