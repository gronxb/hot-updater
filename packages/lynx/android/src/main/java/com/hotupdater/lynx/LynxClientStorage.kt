package com.hotupdater.lynx

import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import org.json.JSONObject

/** Installation-scoped plugin data, independent of OTA generations and binary versions. */
internal class LynxClientStorage(private val directory: File) {
    private val file get() = File(directory, "client.json")

    fun installId(): String = synchronized(lock) {
        val state = read()
        if (state.has("installId")) return@synchronized state.getString("installId")
        val id = UUID.randomUUID().toString()
        write(state.put("installId", id))
        id
    }

    fun get(key: String): String? = synchronized(lock) {
        require(key.startsWith("plugins/")) { "Invalid plugin storage key" }
        read().optJSONObject("values")?.let { values ->
            if (values.has(key)) values.getString(key) else null
        }
    }

    fun set(key: String, value: String?) = synchronized(lock) {
        require(key.startsWith("plugins/")) { "Invalid plugin storage key" }
        require(value == null || value.toByteArray(Charsets.UTF_8).size <= 65_536) {
            "Plugin storage value exceeds 64 KB"
        }
        val state = read()
        val values = state.optJSONObject("values") ?: JSONObject()
        if (value == null) values.remove(key) else values.put(key, value)
        write(state.put("values", values))
    }

    private fun read(): JSONObject = if (file.exists()) JSONObject(file.readText()) else JSONObject()

    private fun write(state: JSONObject) {
        check(directory.isDirectory || directory.mkdirs()) { "Cannot create plugin storage" }
        val temporary = File.createTempFile("client-", ".tmp", directory)
        try {
            FileOutputStream(temporary).use {
                it.write(state.toString().toByteArray(Charsets.UTF_8))
                it.fd.sync()
            }
            check(temporary.renameTo(file)) { "Cannot commit plugin storage" }
        } finally {
            temporary.delete()
        }
    }

    // All page modules read and modify the same file; never retain a stale per-page copy.
    private companion object { val lock = Any() }
}
