package com.hotupdater.lynx.internal

import android.system.Os
import android.system.OsConstants
import java.io.File

/** Publish every newly created directory entry before relying on files beneath it. */
internal object DurableFiles {
    fun directory(directory: File) {
        if (directory.isDirectory) return
        val parent = checkNotNull(directory.parentFile)
        directory(parent)
        check(directory.mkdir() || directory.isDirectory) { "Cannot create private directory" }
        syncDirectory(parent)
        syncDirectory(directory)
    }
    fun replace(from: File, to: File) {
        try { Os.rename(from.path, to.path) } catch (_: Throwable) {}
        if (!from.exists() && to.exists()) return
        java.nio.file.Files.move(
            from.toPath(),
            to.toPath(),
            java.nio.file.StandardCopyOption.ATOMIC_MOVE,
            java.nio.file.StandardCopyOption.REPLACE_EXISTING,
        )
    }
    fun syncDirectory(directory: File) {
        try {
            val descriptor = Os.open(directory.path, OsConstants.O_RDONLY, 0)
            try { Os.fsync(descriptor) } finally { Os.close(descriptor) }
        } catch (_: Throwable) {
            // Android always takes the Os path; JVM unit tests still publish via replace().
        }
    }
}
