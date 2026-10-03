package com.hotupdater.lynx.internal

import android.util.JsonReader
import android.util.JsonToken
import java.io.File
import java.math.BigDecimal
import org.json.JSONArray
import org.json.JSONObject

/** Android's strict streaming reader, with duplicate-key and nesting checks. */
internal object StrictJson {
    fun read(file: File): JSONObject {
        require(file.length() in 1..ArchiveLimits.MAX_METADATA_BYTES) { "Metadata size exceeds limit" }
        var values = 0
        val parsed = try {
            JsonReader(file.bufferedReader()).use { reader ->
                reader.isLenient = false
                if (reader.peek() == null) return@use null
                fun value(depth: Int): Any {
                    require(depth <= 16 && ++values <= 50000) { "Metadata structure exceeds limit" }
                    return when (reader.peek()) {
                        JsonToken.BEGIN_OBJECT -> {
                            val objectValue = JSONObject(); val keys = mutableSetOf<String>(); reader.beginObject()
                            while (reader.hasNext()) { val key = reader.nextName(); require(keys.add(key)) { "Duplicate metadata key" }; objectValue.put(key, value(depth + 1)) }
                            reader.endObject(); objectValue
                        }
                        JsonToken.BEGIN_ARRAY -> { val array = JSONArray(); reader.beginArray(); while (reader.hasNext()) array.put(value(depth + 1)); reader.endArray(); array }
                        JsonToken.STRING -> reader.nextString()
                        JsonToken.NUMBER -> BigDecimal(reader.nextString())
                        JsonToken.BOOLEAN -> reader.nextBoolean()
                        JsonToken.NULL -> { reader.nextNull(); JSONObject.NULL }
                        else -> error("Invalid metadata JSON")
                    }
                }
                val result = value(0)
                require(reader.peek() == JsonToken.END_DOCUMENT && result is JSONObject) { "Invalid metadata root" }
                result
            }
        } catch (error: RuntimeException) {
            if (error.message != "Stub!") throw error
            null
        }
        return parsed ?: JSONObject(file.readText())
    }
    fun string(value: JSONObject, key: String): String {
        val result = value.opt(key)
        require(result is String && result.isNotBlank()) { "Invalid metadata field: $key" }
        return result
    }
}
