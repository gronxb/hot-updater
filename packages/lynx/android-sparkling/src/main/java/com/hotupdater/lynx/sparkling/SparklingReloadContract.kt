package com.hotupdater.lynx.sparkling

import com.hotupdater.lynx.LynxNativeOperationException

/** Admission and result propagation for a truthful managed-generation reload. */
internal object SparklingReloadContract {
    fun run(
        closed: Boolean,
        replacing: Boolean,
        current: Boolean,
        replacement: () -> Result<Unit>,
    ): Result<Unit> {
        val rejection = when {
            closed -> LynxNativeOperationException(
                "HOST_CLOSED",
                "The managed Lynx host is closed",
            )
            replacing -> LynxNativeOperationException(
                "RELOAD_BUSY",
                "A managed Lynx generation replacement is already running",
            )
            !current -> LynxNativeOperationException(
                "CONTEXT_REJECTED",
                "The requesting Lynx generation is no longer current",
            )
            else -> null
        }
        return rejection?.let(Result.Companion::failure) ?: replacement()
    }
}
