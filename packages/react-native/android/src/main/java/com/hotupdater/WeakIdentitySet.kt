package com.hotupdater

import java.lang.ref.ReferenceQueue
import java.lang.ref.WeakReference

/**
 * A set of objects by identity that doesn't keep them alive. An identity
 * hash code alone can't stand for an object: once it is collected, a new
 * object may get the same code, and would be taken for the old one. Thread
 * safe.
 */
internal class WeakIdentitySet<T : Any> {
    private class Entry<T : Any>(
        value: T,
        queue: ReferenceQueue<T>?,
    ) : WeakReference<T>(value, queue) {
        private val hash = System.identityHashCode(value)

        override fun hashCode(): Int = hash

        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Entry<*>) return false
            val value = get() ?: return false
            return value === other.get()
        }
    }

    private val collected = ReferenceQueue<T>()
    private val entries = HashSet<Entry<T>>()

    /** True when [value] was not in the set. */
    @Synchronized
    fun add(value: T): Boolean {
        dropCollected()
        return entries.add(Entry(value, collected))
    }

    @Synchronized
    fun remove(value: T): Boolean {
        dropCollected()
        return entries.remove(Entry(value, null))
    }

    @Synchronized
    operator fun contains(value: T): Boolean {
        dropCollected()
        return Entry(value, null) in entries
    }

    @Synchronized
    fun isEmpty(): Boolean {
        dropCollected()
        return entries.isEmpty()
    }

    val size: Int
        @Synchronized get() {
            dropCollected()
            return entries.size
        }

    @Synchronized
    fun clear() {
        entries.clear()
        while (collected.poll() != null) Unit
    }

    // A collected entry equals only itself, which removes it.
    private fun dropCollected() {
        while (true) {
            val entry = collected.poll() ?: return
            entries.remove(entry)
        }
    }
}
