package com.hotupdater

import android.util.Log
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap

/**
 * Global registry for HotUpdater instances.
 * Uses weak references to allow automatic memory cleanup when instances are garbage collected.
 *
 * Thread-safe implementation using ConcurrentHashMap for lock-free performance.
 */
object HotUpdaterRegistry {
    private const val TAG = "HotUpdaterRegistry"

    // Thread-safe weak reference storage
    private val delegates = ConcurrentHashMap<String, WeakReference<HotUpdaterImpl>>()

    // Track the identifier currently used by getJSBundleFile()
    @Volatile
    private var defaultIdentifier: String? = null

    /**
     * Register a HotUpdaterImpl instance with an identifier.
     * The instance is stored as a weak reference.
     *
     * @param delegate The HotUpdaterImpl instance to register
     * @param identifier Unique identifier for the instance
     */
    fun register(
        delegate: HotUpdaterImpl,
        identifier: String,
    ) {
        delegates[identifier] = WeakReference(delegate)
        Log.d(TAG, "Registered instance with identifier: $identifier")
    }

    /**
     * Get a HotUpdaterImpl instance by identifier.
     * Automatically cleans up dead weak references.
     *
     * @param identifier The identifier to look up
     * @return The HotUpdaterImpl instance or null if not found or garbage collected
     */
    fun get(identifier: String): HotUpdaterImpl? {
        val weakRef = delegates[identifier]
        val impl = weakRef?.get()

        // Clean up dead weak references
        if (weakRef != null && impl == null) {
            delegates.remove(identifier)
            Log.d(TAG, "Cleaned up garbage collected instance: $identifier")
        }

        return impl
    }

    /**
     * Remove an instance from the registry.
     * This is optional - instances are automatically cleaned up when garbage collected.
     *
     * @param identifier The identifier to remove
     */
    fun unregister(identifier: String) {
        delegates.remove(identifier)
        Log.d(TAG, "Unregistered instance: $identifier")
    }

    /**
     * Set the default identifier that is currently being used by getJSBundleFile().
     * This is used for validation to ensure updateBundle uses the same identifier.
     *
     * @param identifier The identifier currently in use (null for default)
     */
    @JvmStatic
    fun setDefaultIdentifier(identifier: String?) {
        defaultIdentifier = identifier
        Log.d(TAG, "Set default identifier: ${identifier ?: "<null>"}")
    }

    /**
     * Get the default identifier currently being used by getJSBundleFile().
     *
     * @return The default identifier or null
     */
    @JvmStatic
    fun getDefaultIdentifier(): String? = defaultIdentifier

    /**
     * Resolve a HotUpdaterImpl instance based on identifier.
     * If identifier is provided, looks it up in the registry.
     * If identifier is null, returns the fallback instance.
     *
     * @param identifier The identifier to look up (null to use fallback)
     * @param fallback The fallback instance to use when identifier is null
     * @return The resolved instance or null if identifier is provided but not found
     */
    @JvmStatic
    fun resolveInstance(
        identifier: String?,
        fallback: HotUpdaterImpl,
    ): HotUpdaterImpl? =
        if (identifier != null) {
            get(identifier)?.also {
                Log.d(TAG, "Using instance with identifier: $identifier")
            }
        } else {
            Log.d(TAG, "Using fallback instance")
            fallback
        }
}
