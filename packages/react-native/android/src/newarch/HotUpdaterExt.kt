package com.hotupdater

import com.facebook.react.ReactHost

/**
 * Extension functions for HotUpdater to support brownfield apps
 */

/**
 * Sets the ReactHost for brownfield apps that don't have ReactApplication
 * Call this method in your Activity or Fragment before using HotUpdater
 * @param reactHost The ReactHost instance
 */
@JvmStatic
fun HotUpdater.Companion.setReactHost(reactHost: ReactHost) {
    ReactHostHolder.setReactHost(reactHost)
}
