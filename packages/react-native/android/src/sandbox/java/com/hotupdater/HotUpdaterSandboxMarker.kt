package com.hotupdater

/**
 * Holds the literal the CLI reads from a built app to tell a sandbox build:
 * SANDBOX_CODE_MARKER in @hot-updater/protocol.
 */
object HotUpdaterSandboxMarker {
    fun value(): String = "HOT_UPDATER_SANDBOX_NATIVE_LAYER"
}
