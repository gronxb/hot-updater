package com.hotupdater

import com.facebook.react.ReactHost

/**
 * Singleton holder for ReactHost (for brownfield apps in new architecture)
 * Use HotUpdater.setReactHost() to set the ReactHost instance
 */
object ReactHostHolder {
    @Volatile
    private var reactHost: ReactHost? = null

    /**
     * Sets the ReactHost for brownfield apps
     * @param host The ReactHost instance
     */
    @JvmStatic
    fun setReactHost(host: ReactHost) {
        synchronized(this) {
            reactHost = host
        }
    }

    /**
     * Gets the ReactHost
     * @return The ReactHost instance or null if not set
     */
    @JvmStatic
    fun getReactHost(): ReactHost? = reactHost

    /**
     * Clears the ReactHost instance
     */
    @JvmStatic
    fun clear() {
        synchronized(this) {
            reactHost = null
        }
    }
}
