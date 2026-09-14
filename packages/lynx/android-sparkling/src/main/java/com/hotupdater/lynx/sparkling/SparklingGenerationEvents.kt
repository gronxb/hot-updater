package com.hotupdater.lynx.sparkling

import android.content.Context
import android.util.Log
import com.hotupdater.lynx.LynxGenerationEventJournal
import java.util.UUID

internal class SparklingRuntimeEventSink(
    private val record: (String, Map<String, Any?>) -> Unit,
    private val recordOnce: (
        String,
        String,
        String,
        Map<String, Any?>,
    ) -> Boolean,
    private val listener: HotUpdaterSparklingEventListener?,
) : HotUpdaterSparklingEventListener {
    internal constructor(
        record: (String, Map<String, Any?>) -> Unit,
        listener: HotUpdaterSparklingEventListener?,
    ) : this(
        record,
        { name, _, _, details -> record(name, details); true },
        listener,
    )

    constructor(
        context: Context,
        listener: HotUpdaterSparklingEventListener?,
    ) : this(
        LynxGenerationEventJournal(context)::append,
        LynxGenerationEventJournal(context)::appendOnce,
        listener,
    )

    override fun onEvent(name: String, details: Map<String, Any?>) {
        try {
            validateManagedIdentity(details)
            record(name, details)
        } catch (error: Throwable) {
            runCatching {
                Log.e(TAG, "Could not persist managed Lynx runtime event", error)
            }
        }
        notifyListener(name, details)
    }

    fun onTerminalEvent(details: Map<String, Any?>): Boolean {
        val pageAttemptId = details["pageAttemptId"] as? String
            ?: error("A page terminal requires pageAttemptId")
        val durable = runCatching {
            validateManagedIdentity(details)
            recordOnce(
                "pageAttemptTerminal",
                "pageAttemptId",
                pageAttemptId,
                details,
            )
        }.onFailure { error ->
            runCatching {
                Log.e(TAG, "Could not persist managed Lynx page terminal", error)
            }
        }.isSuccess
        notifyListener("pageAttemptTerminal", details)
        return durable
    }

    private fun notifyListener(name: String, details: Map<String, Any?>) {
        runCatching { listener?.onEvent(name, details) }
            .onFailure { error ->
                runCatching {
                    Log.e(TAG, "Managed Lynx event observer failed", error)
                }
            }
    }

    private fun validateManagedIdentity(details: Map<String, Any?>) {
        val required = setOf(
            "runtimeId",
            "processId",
            "generationId",
            "bundleId",
            "releaseId",
            "contextId",
            "pageAttemptId",
            "transitionId",
        )
        check(details.keys.containsAll(required)) {
            "Managed Lynx event identity is incomplete"
        }
        listOf("runtimeId", "generationId", "bundleId").forEach { key ->
            check((details[key] as? String)?.isNotEmpty() == true) {
                "Managed Lynx event $key is invalid"
            }
        }
        check(
            (details["processId"] as? String)?.matches(POSITIVE_DECIMAL) == true,
        ) { "Managed Lynx event processId is invalid" }
        listOf("releaseId", "contextId", "pageAttemptId", "transitionId")
            .forEach { key ->
                check(details[key] == null ||
                    (details[key] as? String)?.isNotEmpty() == true) {
                    "Managed Lynx event $key is invalid"
                }
            }
    }

    companion object {
        private const val TAG = "HotUpdaterSparkling"
        private val POSITIVE_DECIMAL = Regex("^[1-9][0-9]*$")
    }
}

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
            notifyListener(name, details)
            true
        }

    fun emitTerminal(details: Map<String, Any?>): Boolean = synchronized(lock) {
        if (!accepting) return@synchronized false
        val sink = listener
        if (sink is SparklingRuntimeEventSink) {
            sink.onTerminalEvent(details)
        } else {
            notifyListener("pageAttemptTerminal", details)
            true
        }
    }

    fun resourceLoaded(
        name: String,
        details: Map<String, Any?>,
    ): Boolean = synchronized(lock) {
        if (!accepting) return@synchronized false
        val key = "${details["contextId"]}\u0000${details["path"]}"
        if (leases.putIfAbsent(key, details) == null) {
            notifyListener("resourceLeaseAcquired", details)
        }
        notifyListener(name, details)
        true
    }

    fun beginRetirement(details: Map<String, Any?>) = synchronized(lock) {
        if (!accepting) return@synchronized
        accepting = false
        notifyListener("generationWillRetire", details)
    }

    fun finishRetirement(details: Map<String, Any?>) = synchronized(lock) {
        if (retired) return@synchronized
        accepting = false
        leases.toSortedMap().values.forEach {
            notifyListener("resourceLeaseReleased", it)
        }
        leases.clear()
        notifyListener(
            "generationRetired",
            details + ("inFlightResourceCount" to inFlightResources),
        )
        retired = true
    }

    private fun notifyListener(name: String, details: Map<String, Any?>) {
        runCatching { listener?.onEvent(name, details) }
            .onFailure { error ->
                runCatching {
                    Log.e(TAG, "Managed Lynx generation observer failed", error)
                }
            }
    }

    companion object {
        private const val TAG = "HotUpdaterSparkling"
    }
}
