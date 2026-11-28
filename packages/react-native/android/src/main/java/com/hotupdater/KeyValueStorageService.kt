package com.hotupdater

import android.content.Context
import android.util.Log
import androidx.core.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream

/**
 * The persistent string key-value store behind `getStorageItem` and
 * `setStorageItem`, which client plugins use through JS. Keys are opaque
 * here; JS scopes them per plugin.
 *
 * Values live as one JSON object in a file outside device backups. The file
 * is read once, on first use, and rewritten atomically on every set. A
 * missing, unreadable, or corrupt file reads as empty and is replaced by the
 * next set. A set that cannot be persisted still applies for this process.
 */
class KeyValueStorageService(
    private val file: File,
) {
    companion object {
        private const val TAG = "KeyValueStorage"
        const val FILENAME = "storage.json"

        /** The store kept in `noBackupFilesDir/hot-updater/storage.json`. */
        fun create(context: Context): KeyValueStorageService = KeyValueStorageService(NoBackupStorage.file(context, FILENAME))
    }

    private var values: MutableMap<String, String>? = null

    // Whether the file holds [values]: a set that changes nothing then skips
    // the write, and its fsync. A failed write or an unreadable file clears it,
    // so the next set writes again.
    private var persisted = true

    @Synchronized
    fun getItem(key: String): String? = loadValues()[key]

    /** Stores [value] under [key], or removes [key] when [value] is null. */
    @Synchronized
    fun setItem(
        key: String,
        value: String?,
    ) {
        val values = loadValues()
        if (persisted && values[key] == value) return
        if (value == null) {
            values.remove(key)
        } else {
            values[key] = value
        }
        persisted = write(values)
    }

    private fun loadValues(): MutableMap<String, String> = values ?: read().also { values = it }

    private fun read(): MutableMap<String, String> =
        try {
            val json =
                AtomicFile(file).openRead().use { input ->
                    JSONObject(String(input.readBytes(), Charsets.UTF_8))
                }
            val stored = linkedMapOf<String, String>()
            json.keys().forEach { key ->
                (json.opt(key) as? String)?.let { stored[key] = it }
            }
            stored
        } catch (_: FileNotFoundException) {
            linkedMapOf()
        } catch (e: Exception) {
            // The message of a parse error can quote stored values, so it is not logged.
            Log.w(TAG, "Ignoring unreadable storage file (${e.javaClass.simpleName})")
            persisted = false
            linkedMapOf()
        }

    private fun write(values: Map<String, String>): Boolean {
        val atomicFile = AtomicFile(file)
        var output: FileOutputStream? = null
        return try {
            file.parentFile?.mkdirs()
            output = atomicFile.startWrite()
            output.write(JSONObject(values).toString().toByteArray(Charsets.UTF_8))
            atomicFile.finishWrite(output)
            // finishWrite logs a failed rename instead of throwing, leaving the new file behind.
            file.isFile && !File("${file.path}.new").exists()
        } catch (e: Exception) {
            output?.let(atomicFile::failWrite)
            Log.w(TAG, "Failed to persist storage", e)
            false
        }
    }
}
