package com.hotupdater.lynx.internal

import android.annotation.SuppressLint
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileDescriptor
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption

internal interface DirectorySyncPlatform {
    fun open(path: String): FileDescriptor?
    fun fsync(descriptor: FileDescriptor)
    fun close(descriptor: FileDescriptor)
}

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
    @SuppressLint("NewApi")
    fun replace(from: File, to: File) {
        try {
            Os.rename(from.path, to.path)
            if (!from.exists() && to.exists()) return
        } catch (error: RuntimeException) {
            if (error.message != "Stub!") throw error
        }
        // java.nio is used only by local JVM tests where android.system.Os is a stub.
        java.nio.file.Files.move(
            from.toPath(),
            to.toPath(),
            java.nio.file.StandardCopyOption.ATOMIC_MOVE,
            java.nio.file.StandardCopyOption.REPLACE_EXISTING,
        )
    }
    fun syncDirectory(directory: File) {
        try {
            syncDirectory(directory, AndroidDirectorySyncPlatform)
        } catch (_: AndroidOsStubException) {
            syncDirectoryWithNio(directory)
        } catch (error: RuntimeException) {
            if (error.message != "Stub!") throw error
            syncDirectoryWithNio(directory)
        }
    }

    internal fun syncDirectory(
        directory: File,
        platform: DirectorySyncPlatform,
    ) {
        require(directory.isDirectory) { "Directory sync target is invalid" }
        val descriptor = platform.open(directory.path)
            ?: throw AndroidOsStubException()
        var failure: Throwable? = null
        try {
            platform.fsync(descriptor)
        } catch (error: Throwable) {
            failure = error
        }
        try {
            platform.close(descriptor)
        } catch (error: Throwable) {
            if (failure == null) failure = error else failure.addSuppressed(error)
        }
        failure?.let { throw it }
    }

    private object AndroidDirectorySyncPlatform : DirectorySyncPlatform {
        override fun open(path: String): FileDescriptor? =
            Os.open(path, OsConstants.O_RDONLY, 0)
        override fun fsync(descriptor: FileDescriptor) = Os.fsync(descriptor)
        override fun close(descriptor: FileDescriptor) = Os.close(descriptor)
    }

    @SuppressLint("NewApi")
    private fun syncDirectoryWithNio(directory: File) {
        // Local JVM tests use Android stubs; the NIO directory force is real.
        FileChannel.open(directory.toPath(), StandardOpenOption.READ).use {
            it.force(true)
        }
    }

    private class AndroidOsStubException : RuntimeException()
}
