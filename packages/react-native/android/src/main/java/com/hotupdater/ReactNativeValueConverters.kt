package com.hotupdater

import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.WritableNativeArray
import com.facebook.react.bridge.WritableNativeMap

internal fun Map<String, Any?>.toWritableNativeMap(): WritableNativeMap {
    val result = WritableNativeMap()
    forEach { (key, value) ->
        result.putReactValue(key, value)
    }
    return result
}

internal fun List<*>.toWritableNativeArray(): WritableNativeArray {
    val result = WritableNativeArray()
    forEach { value ->
        result.pushReactValue(value)
    }
    return result
}

private fun WritableMap.putReactValue(
    key: String,
    value: Any?,
) {
    when (value) {
        null -> putNull(key)
        is Boolean -> putBoolean(key, value)
        is Number -> putDouble(key, value.toDouble())
        is String -> putString(key, value)
        is Map<*, *> -> {
            @Suppress("UNCHECKED_CAST")
            putMap(key, (value as Map<String, Any?>).toWritableNativeMap())
        }
        is List<*> -> putArray(key, value.toWritableNativeArray())
        else -> putString(key, value.toString())
    }
}

private fun WritableArray.pushReactValue(value: Any?) {
    when (value) {
        null -> pushNull()
        is Boolean -> pushBoolean(value)
        is Number -> pushDouble(value.toDouble())
        is String -> pushString(value)
        is Map<*, *> -> {
            @Suppress("UNCHECKED_CAST")
            pushMap((value as Map<String, Any?>).toWritableNativeMap())
        }
        is List<*> -> pushArray(value.toWritableNativeArray())
        else -> pushString(value.toString())
    }
}
