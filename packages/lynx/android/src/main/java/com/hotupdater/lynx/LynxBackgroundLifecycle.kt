package com.hotupdater.lynx

/** Main-thread task settlement. Requesting engine destruction is not a native teardown acknowledgement. */
internal class LynxBackgroundLifecycle(
    private val destroy: () -> Unit,
    private val persistFatal: (String) -> Unit,
    private val release: () -> Unit,
    private val reply: (Result<String>) -> Unit,
) {
    var stopping = false
        private set
    private var destroyed = false
    private var replied = false
    private var outcome: Result<String>? = null

    fun complete(value: String) {
        if (stopping || destroyed) return
        // Bound retained bridge output independently of the authenticated script size.
        if (value.length > 16 * 1024) {
            stop(IllegalArgumentException("Lynx background result exceeds 16 Ki characters"))
            return
        }
        outcome = Result.success(value)
        requestDestroy()
    }

    fun nativeError(error: Throwable, fatal: Boolean) {
        if (destroyed) return
        if (fatal) runCatching { persistFatal(error.message ?: "Lynx background runtime failed") }
            .exceptionOrNull()?.let(error::addSuppressed)
        // A native fatal queued after JS completion still belongs to this runtime.
        outcome = Result.failure(error)
        requestDestroy()
    }

    fun stop(error: Throwable) {
        if (destroyed) return
        outcome = Result.failure(error)
        requestDestroy()
        // An engine stuck in JavaScript may never acknowledge destruction.
        // Finish the OS callback, but keep its native reservation until native teardown.
        deliver(Result.failure(error))
    }

    fun onDestroyed() {
        if (destroyed) return
        destroyed = true
        val result = runCatching { release() }.fold(
            { outcome ?: Result.failure(IllegalStateException("Lynx background runtime destroyed before completion")) },
            { Result.failure(it) },
        )
        deliver(result)
    }

    private fun requestDestroy() {
        if (stopping) return
        stopping = true
        runCatching(destroy).exceptionOrNull()?.let {
            outcome = Result.failure(it)
            deliver(Result.failure(it))
        }
    }

    private fun deliver(result: Result<String>) {
        if (replied) return
        replied = true
        reply(result)
    }
}
