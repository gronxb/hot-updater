package com.hotupdater

import org.json.JSONArray
import org.json.JSONObject

/**
 * The plugin events of native update checks, queued in the key-value store
 * for JavaScript to take after the next launch (nativeUpdateEvents.ts): a
 * JSON array of `{ name, payload, occurredAt }`, oldest first, keeping the
 * newest [MAX_EVENTS_PER_NAME] of each name. Every occurrence is kept, and
 * [take] hands each event out at most once.
 */
internal class NativeUpdateEventQueue(
    private val getItem: (String) -> String?,
    private val setItem: (String, String?) -> Unit,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    companion object {
        const val STORAGE_KEY = "hot-updater/native-update-events"
        const val MAX_EVENTS_PER_NAME = 20

        /** Guards appends and takes across every queue over the same store. */
        private val lock = Any()
    }

    fun add(
        name: String,
        payload: JSONObject,
    ) {
        synchronized(lock) {
            val events = read() ?: JSONArray()
            events.put(
                JSONObject()
                    .put("name", name)
                    .put("payload", payload)
                    .put("occurredAt", clock()),
            )
            var sameName = (0 until events.length()).count { nameAt(events, it) == name }
            var index = 0
            while (sameName > MAX_EVENTS_PER_NAME && index < events.length()) {
                if (nameAt(events, index) == name) {
                    events.remove(index)
                    sameName -= 1
                } else {
                    index += 1
                }
            }
            setItem(STORAGE_KEY, events.toString())
        }
    }

    /** The queued events as a JSON array, cleared from the store, or null when there are none. */
    fun take(): String? =
        synchronized(lock) {
            if (getItem(STORAGE_KEY) == null) return@synchronized null
            val events = read()
            setItem(STORAGE_KEY, null)
            events?.takeIf { it.length() > 0 }?.toString()
        }

    private fun read(): JSONArray? =
        getItem(STORAGE_KEY)?.let { stored ->
            try {
                JSONArray(stored)
            } catch (_: Exception) {
                null
            }
        }

    private fun nameAt(
        events: JSONArray,
        index: Int,
    ): String? = events.optJSONObject(index)?.optString("name")
}
