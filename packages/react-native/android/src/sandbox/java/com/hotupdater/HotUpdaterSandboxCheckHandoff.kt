package com.hotupdater

import java.util.UUID

/**
 * The sandbox's own restart of the app for a link that waits for a server,
 * handed to the process it starts, so that process asks the link over the app
 * once the app's check answers.
 *
 * The record holds a token and the link. The token travels only in that
 * restart's intent, so a launch without it (a notification, the launcher, an
 * app link) takes nothing, nor does one for another link. Taking it clears the
 * record: a copy of that intent, or the system restoring it after the process
 * died, finds nothing. A restart that never arrived leaves a record no launch
 * matches, and its link waits for the next screen, as after any other launch.
 */
internal class HotUpdaterSandboxCheckHandoffs(
    private val read: () -> String?,
    private val write: (String?) -> Unit,
    private val newToken: () -> String = { UUID.randomUUID().toString() },
) {
    /** Records a restart for [url], before it goes out. Returns the token its intent carries. */
    fun issue(url: String): String {
        val token = newToken()
        write("$token\n$url")
        return token
    }

    /** The link a launch's intent hands over: only with the token recorded for that link, and only once. */
    fun take(
        token: String?,
        url: String?,
    ): String? {
        if (token == null || url == null) return null
        val recorded = read()?.split('\n', limit = 2) ?: return null
        if (recorded.size != 2 || recorded[0] != token || recorded[1] != url) return null
        write(null)
        return url
    }
}

/**
 * A handed-over link, for the app's activity the screen starts in this process.
 * Only the first of the app's activities to resume can take it, and only if it
 * is that activity: any other first one, such as a notification's, drops it.
 */
internal data class HotUpdaterSandboxHostHandoff(
    val url: String,
    val hostClassName: String,
) {
    fun forFirstResume(className: String): String? = url.takeIf { className == hostClassName }
}
