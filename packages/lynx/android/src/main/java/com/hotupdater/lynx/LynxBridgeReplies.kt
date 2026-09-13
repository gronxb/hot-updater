package com.hotupdater.lynx

import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

/** A stable native error code that can cross the Lynx callback envelope. */
class LynxNativeOperationException(
    val code: String,
    message: String,
    cause: Throwable? = null,
) : IllegalStateException(message, cause)

/** Settles accepted bridge operations when their owning generation is retired. */
internal class LynxBridgeReplies {
    internal data class Ticket(val id: Long)

    private val lock = Any()
    private val callbacks = linkedMapOf<Long, (Result<JSONObject>) -> Unit>()
    private var nextId = 0L
    private var closed = false

    fun register(callback: (Result<JSONObject>) -> Unit): Ticket? {
        val ticket = synchronized(lock) {
            if (closed) null else Ticket(nextId++).also {
                callbacks[it.id] = callback
            }
        }
        if (ticket == null) callback(Result.failure(contextRejected()))
        return ticket
    }

    fun settle(ticket: Ticket, result: Result<JSONObject>) {
        val callback = synchronized(lock) { callbacks.remove(ticket.id) }
        callback?.invoke(result)
    }

    fun close() {
        val pending = synchronized(lock) {
            if (closed) return
            closed = true
            callbacks.values.toList().also { callbacks.clear() }
        }
        pending.forEach { it(Result.failure(contextRejected())) }
    }

    private fun contextRejected() = LynxNativeOperationException(
        "CONTEXT_REJECTED",
        "The native Lynx context was retired before the operation completed",
    )
}

/** Protects a host-owned asynchronous reply from duplicate completion. */
internal class LynxOnceReply<T>(
    private val callback: (Result<T>) -> Unit,
) {
    private val settled = AtomicBoolean()

    fun settle(result: Result<T>) {
        if (settled.compareAndSet(false, true)) callback(result)
    }
}
