package com.hotupdater

import org.json.JSONArray
import org.json.JSONObject

/**
 * The plugin events of native update checks, queued in the key-value store
 * for JavaScript to take after the next launch (nativeUpdateEvents.ts): a
 * JSON array of `{ name, payload, occurredAt }`, oldest first, keeping the
 * newest [MAX_EVENTS_PER_NAME] of each name. Every occurrence is kept, and
 * [take] hands each event out at most once. Each event records the native
 * [build] and cohort it happened in; [take] drops events of another, such as
 * the app version before an upgrade or a cohort set since, so none is
 * reported against a release or cohort it did not happen in.
 */
internal class NativeUpdateEventQueue(
    private val getItem: (String) -> String?,
    private val setItem: (String, String?) -> Unit,
    private val build: () -> String,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    companion object {
        const val STORAGE_KEY = "hot-updater/native-update-events"
        const val MAX_EVENTS_PER_NAME = 20

        /** Guards appends and takes across every queue over the same store. */
        private val lock = Any()

        /**
         * What an event is reported under: the native build (its app version
         * and the minimum bundle ID its build generated) and the cohort.
         */
        fun buildOf(
            appVersion: String?,
            minBundleId: String,
            cohort: String,
        ): String = "${appVersion.orEmpty()}|$minBundleId|${ReleaseSelector.normalizeCohortValue(cohort)}"
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
                    .put("occurredAt", clock())
                    .put("build", build()),
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

    /** Drops every queued event named [name]. */
    fun remove(name: String) {
        synchronized(lock) {
            val events = read() ?: return
            val kept = JSONArray()
            for (index in 0 until events.length()) {
                if (nameAt(events, index) != name) kept.put(events.get(index))
            }
            setItem(STORAGE_KEY, if (kept.length() == 0) null else kept.toString())
        }
    }

    /** The queued events as a JSON array, cleared from the store, or null when there are none. */
    fun take(): String? =
        synchronized(lock) {
            if (getItem(STORAGE_KEY) == null) return@synchronized null
            val events = read()
            setItem(STORAGE_KEY, null)
            val current = build()
            val taken = JSONArray()
            if (events != null) {
                for (index in 0 until events.length()) {
                    val event = events.optJSONObject(index) ?: continue
                    if (event.optString("build") == current) taken.put(event)
                }
            }
            taken.takeIf { it.length() > 0 }?.toString()
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
