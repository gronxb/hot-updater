package com.hotupdater.lynx.sparkling

import java.util.UUID

internal class SparklingGenerationEvents(
    private val listener: HotUpdaterSparklingEventListener?,
    val id: String = UUID.randomUUID().toString(),
) {
    private val lock = Any()
    private val leases = linkedMapOf<String, Map<String, Any?>>()
    private var accepting = true
    private var retired = false
    private var inFlightResources = 0

    fun resourceOperation(operation: () -> Unit): Boolean = synchronized(lock) {
        if (!accepting) return@synchronized false
        inFlightResources += 1
        try {
            operation()
            true
        } finally {
            inFlightResources -= 1
        }
    }

    fun emit(name: String, details: Map<String, Any?>): Boolean =
        synchronized(lock) {
            if (!accepting) return@synchronized false
            listener?.onEvent(name, details)
            true
        }

    fun resourceLoaded(
        name: String,
        details: Map<String, Any?>,
    ): Boolean = synchronized(lock) {
        if (!accepting) return@synchronized false
        val key = "${details["contextId"]}\u0000${details["path"]}"
        if (leases.putIfAbsent(key, details) == null) {
            listener?.onEvent("resourceLeaseAcquired", details)
        }
        listener?.onEvent(name, details)
        true
    }

    fun beginRetirement(details: Map<String, Any?>) = synchronized(lock) {
        if (!accepting) return@synchronized
        accepting = false
        listener?.onEvent("generationWillRetire", details)
    }

    fun finishRetirement(details: Map<String, Any?>) = synchronized(lock) {
        if (retired) return@synchronized
        accepting = false
        leases.toSortedMap().values.forEach {
            listener?.onEvent("resourceLeaseReleased", it)
        }
        leases.clear()
        listener?.onEvent(
            "generationRetired",
            details + ("inFlightResourceCount" to inFlightResources),
        )
        retired = true
    }
}
