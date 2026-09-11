package com.hotupdater.lynx

import com.hotupdater.lynx.internal.DurableFiles
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.UUID

/** One process owns a scope; checked fsync/rename precede in-memory publication. */
internal class LynxStateStore(private val directory: File) {
    private val ownerFile: RandomAccessFile
    @Suppress("unused") private val processLock: java.nio.channels.FileLock
    private val stateFile = File(directory, "state.json")
    var value: JSONObject
        private set
    init {
        DurableFiles.directory(directory)
        ownerFile = RandomAccessFile(File(directory, "state.lock"), "rw")
        processLock = checkNotNull(ownerFile.channel.tryLock()) { "Another process owns this Lynx scope" }
        value = if (stateFile.exists()) JSONObject(stateFile.readText()) else JSONObject()
        directory.listFiles().orEmpty().filter { it.name.startsWith("state.next-") }.forEach { check(it.delete()) }
    }
    fun update(change: (JSONObject) -> Unit) {
        val next = JSONObject(value.toString())
        change(next)
        val staging = File(directory, "state.next-${UUID.randomUUID()}")
        try {
            FileOutputStream(staging).use { output -> output.write(next.toString().toByteArray()); output.fd.sync() }
            // Unlike Android AtomicFile.finishWrite, these APIs report fsync and rename failures.
            DurableFiles.replace(staging, stateFile)
            DurableFiles.syncDirectory(directory)
            value = next
        } finally { if (staging.exists()) check(staging.delete()) { "Could not remove failed state preparation" } }
    }
    fun close() {
        try { processLock.release() } finally { ownerFile.close() }
    }
}
