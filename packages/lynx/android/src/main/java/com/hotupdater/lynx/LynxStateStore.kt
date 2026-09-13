package com.hotupdater.lynx

import com.hotupdater.lynx.internal.DurableFiles
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.UUID

/** One process owns a scope; checked fsync/rename precede in-memory publication. */
internal class LynxStateStore(
    private val directory: File,
    private val syncDirectory: (File) -> Unit = DurableFiles::syncDirectory,
) {
    private val ownerFile: RandomAccessFile
    @Suppress("unused") private val processLock: java.nio.channels.FileLock
    private val stateFile = File(directory, "state.json")
    private var closed = false
    var value: JSONObject
        private set
    init {
        DurableFiles.directory(directory)
        ownerFile = RandomAccessFile(File(directory, "state.lock"), "rw")
        processLock = checkNotNull(ownerFile.channel.tryLock()) { "Another process owns this Lynx scope" }
        value = if (stateFile.exists()) JSONObject(stateFile.readText()) else JSONObject()
        directory.listFiles().orEmpty().filter {
            it.name.startsWith("state.next-") || it.name.startsWith("state.rollback-")
        }.forEach { check(it.delete()) }
    }
    @Synchronized fun update(change: (JSONObject) -> Unit) {
        check(!closed) { "The Lynx state store is closed" }
        val next = JSONObject(value.toString())
        change(next)
        val staging = File(directory, "state.next-${UUID.randomUUID()}")
        val previous = stateFile.takeIf(File::isFile)?.readBytes()
        try {
            FileOutputStream(staging).use { output -> output.write(next.toString().toByteArray()); output.fd.sync() }
            // Unlike Android AtomicFile.finishWrite, these APIs report fsync and rename failures.
            DurableFiles.replace(staging, stateFile)
            try {
                syncDirectory(directory)
            } catch (error: Throwable) {
                try {
                    restore(previous)
                    syncDirectory(directory)
                } catch (rollbackError: Throwable) {
                    error.addSuppressed(rollbackError)
                }
                throw error
            }
            value = next
        } finally { if (staging.exists()) check(staging.delete()) { "Could not remove failed state preparation" } }
    }

    private fun restore(previous: ByteArray?) {
        if (previous == null) {
            check(!stateFile.exists() || stateFile.delete()) {
                "Could not restore the empty state journal"
            }
            return
        }
        val rollback = File(directory, "state.rollback-${UUID.randomUUID()}")
        try {
            FileOutputStream(rollback).use { output ->
                output.write(previous)
                output.fd.sync()
            }
            DurableFiles.replace(rollback, stateFile)
        } finally {
            if (rollback.exists()) {
                check(rollback.delete()) { "Could not remove state rollback preparation" }
            }
        }
    }
    @Synchronized fun close() {
        if (closed) return
        closed = true
        try { processLock.release() } finally { ownerFile.close() }
    }
}
