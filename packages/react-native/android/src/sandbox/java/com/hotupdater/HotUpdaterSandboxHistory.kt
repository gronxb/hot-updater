package com.hotupdater

/**
 * A preview this device opened. Local memory, so it can be stale: it says what
 * was opened, not what the server has now.
 */
internal data class HotUpdaterSandboxHistoryEntry(
    val channel: String,
    val bundleId: String,
    /** The deploy message of [bundleId], when this device saw one. */
    val message: String?,
    val openedAtMs: Long,
)

/** A deploy message, kept with its bundle: a channel's next bundle says something else. */
internal data class HotUpdaterSandboxBundleMessage(
    val bundleId: String,
    val message: String,
)

internal object HotUpdaterSandboxHistory {
    const val LIMIT = 10
    private const val MESSAGE_LIMIT = 20
    private const val DAY_MS = 86_400_000L

    /** Newest first, one entry per channel, at most [LIMIT]. */
    fun adding(
        entry: HotUpdaterSandboxHistoryEntry,
        history: List<HotUpdaterSandboxHistoryEntry>,
    ): List<HotUpdaterSandboxHistoryEntry> = (listOf(entry) + history.filter { it.channel != entry.channel }).take(LIMIT)

    fun remembering(
        message: HotUpdaterSandboxBundleMessage,
        messages: List<HotUpdaterSandboxBundleMessage>,
    ): List<HotUpdaterSandboxBundleMessage> = (listOf(message) + messages.filter { it.bundleId != message.bundleId }).take(MESSAGE_LIMIT)

    fun openedText(
        openedAtMs: Long,
        nowMs: Long,
    ): String =
        when (val days = (nowMs - openedAtMs).coerceAtLeast(0) / DAY_MS) {
            0L -> "Opened today"
            1L -> "Opened yesterday"
            else -> "Opened $days days ago"
        }
}
