package com.hotupdater.mocks

import com.hotupdater.PreferencesService

/**
 * Mock implementation of PreferencesService for testing.
 *
 * This implementation stores data in memory and can be used for testing
 * preferences-related functionality without requiring a real Android Context
 * or SharedPreferences.
 *
 * @example
 * ```kotlin
 * @Test
 * fun testPreferences() {
 *     val prefs = MockPreferencesService()
 *     prefs.setItem("key", "value")
 *     assertEquals("value", prefs.getItem("key"))
 * }
 * ```
 */
class MockPreferencesService : PreferencesService {
    private val storage = mutableMapOf<String, String?>()

    /**
     * Gets a stored preference value.
     *
     * @param key The key to retrieve
     * @return The stored value or null if not found
     */
    override fun getItem(key: String): String? = storage[key]

    /**
     * Sets a preference value.
     *
     * @param key The key to store under
     * @param value The value to store (or null to remove)
     */
    override fun setItem(
        key: String,
        value: String?,
    ) {
        if (value == null) {
            storage.remove(key)
        } else {
            storage[key] = value
        }
    }

    /**
     * Clears all stored preferences.
     *
     * Useful for resetting state between tests.
     */
    fun clear() {
        storage.clear()
    }

    /**
     * Gets all stored key-value pairs.
     *
     * @return A map of all stored preferences
     */
    fun getAll(): Map<String, String?> = storage.toMap()

    /**
     * Checks if a key exists in storage.
     *
     * @param key The key to check
     * @return true if the key exists, false otherwise
     */
    fun contains(key: String): Boolean = storage.containsKey(key)

    /**
     * Gets the number of stored items.
     *
     * @return The size of the storage
     */
    fun size(): Int = storage.size
}
