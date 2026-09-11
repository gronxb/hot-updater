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
    fun syncDirectory(directory: File) {
        val descriptor = Os.open(directory.path, OsConstants.O_RDONLY, 0)
        try { Os.fsync(descriptor) } finally { Os.close(descriptor) }
    }
}
