package com.hotupdater.lynx.internal

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import org.json.JSONObject

/** A background runtime owns only these copied bytes, never installed file paths. */
internal object LynxBackgroundScript {
    const val MAX_BYTES = 16 * 1024 * 1024
    private val ENTRY = Regex(
        "^(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?/)*" +
            "[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\\.js$",
    )

    fun entry(metadata: JSONObject, paths: Set<String>, root: File?): String? {
        if (!metadata.has("backgroundEntry")) return null
        val entry = StrictJson.string(metadata, "backgroundEntry")
        require(ENTRY.matches(entry) && ManagedPaths.normalize(entry) == entry && entry in paths) {
            "Invalid Lynx background entry"
        }
        if (root != null) read(root, entry)
        return entry
    }

    fun read(root: File, entry: String, expectedHash: String? = null): String {
        val file = ManagedPaths.resolve(root, entry)
        require(file.isFile && file.length() in 1..MAX_BYTES.toLong()) {
            "Lynx background script size/type limit exceeded"
        }
        val bytes = file.inputStream().use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                require(output.size() + count <= MAX_BYTES) { "Lynx background script size limit exceeded" }
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        }
        require(bytes.isNotEmpty()) { "Empty Lynx background script" }
        require(bytes.none { it == 0.toByte() }) { "Lynx background scripts must not contain NUL characters" }
        if (expectedHash != null) {
            val digest = HashUtils.calculateSHA256(bytes)
            require(digest == expectedHash) { "Lynx background script changed after verification" }
        }
        return Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes)).toString()
    }
}
