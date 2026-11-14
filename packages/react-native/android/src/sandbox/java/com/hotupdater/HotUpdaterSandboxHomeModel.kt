package com.hotupdater

/** What the build and the SDK's store hold, for the Info tab and the big row. */
internal data class HotUpdaterSandboxDetails(
    val builtInBundleId: String,
    val fingerprintHash: String?,
    /** A staged bundle no launch has verified yet. */
    val pendingBundleId: String?,
)

/**
 * What the Home and Info tabs say, worked out from the coordinator's state with
 * no view in sight. iOS's copy says the same words.
 */
internal data class HotUpdaterSandboxHomeModel(
    val banner: Banner?,
    val bigRow: BigRow,
    val status: Status?,
    val isBusy: Boolean,
    val downloaded: List<Downloaded>,
    /** The count and size, or what the list is for while it's empty. */
    val downloadedFooter: String,
    /** Before a server answered, what previews wait for. */
    val previewHint: String?,
    /**
     * Whether Enter a channel opens. A typed channel needs a server to ask, so
     * the row waits for one, with [previewHint] under it saying what to do.
     */
    val canEnterChannel: Boolean,
) {
    data class Banner(
        val text: String,
        /** A bundle that crashed and stays selected: the way out is a reset. */
        val offersReset: Boolean,
    )

    /** What a tap on the big row does, worked out with its words, so the two agree. */
    enum class Action {
        /** Opens the app on the selection. */
        OPEN,

        /** Over the app, runs the selection in place of what runs. */
        OPEN_OVER_APP,

        /** Runs the app again: what a launch selects now, or the stored bundle. */
        RELOAD_APP,

        /** Loads the dev server's JavaScript again. */
        RELOAD_DEV_SERVER,
        ;

        /** Open's icon, or Reload's. */
        val opens: Boolean get() = this == OPEN || this == OPEN_OVER_APP
    }

    data class BigRow(
        val caption: String,
        val title: String,
        val subtitle: String?,
        val detail: String?,
        val action: Action,
        /** A stored bundle runs: a row under it goes back to the current bundle. */
        val showsBack: Boolean = false,
    )

    /** A row of the Downloaded list. */
    data class Downloaded(
        val bundleId: String,
        val channel: String,
        val message: String?,
        val detail: String,
        val isRunning: Boolean,
    )

    data class Status(
        val text: String,
        /** From 0 to 1 while a download reports it. */
        val progress: Double?,
    )

    companion object {
        const val HINT = "Shake the device to come back here."

        /** A typed channel doesn't ask first, so this says it up front. */
        const val SWITCH_NOTE = "Opening a channel runs its latest bundle. Downloaded bundles stay listed."
        const val RESET_NOTE = "Removes the channel switch. Downloaded bundles stay listed."
        const val EMPTY_DOWNLOADED = "Bundles you open from a QR code, a link, or a channel stay here."

        /** Until a server answers one of the app's checks, the link path's next step. */
        const val NO_SERVER = "No update server yet. Open the app so it can check for updates."

        fun of(
            state: HotUpdaterSandboxState,
            isOverApp: Boolean,
            runningDevServerHost: String? = null,
            nowMs: Long,
        ): HotUpdaterSandboxHomeModel {
            val history = state.downloaded
            return HotUpdaterSandboxHomeModel(
                banner = state.lastLaunch?.let { banner(it, state) },
                bigRow = bigRow(state, isOverApp, runningDevServerHost),
                status = status(state.phase),
                isBusy = state.phase is HotUpdaterSandboxPhase.Working,
                downloaded =
                    history.map {
                        Downloaded(
                            bundleId = it.bundleId,
                            channel = it.channel,
                            message = it.message,
                            detail = "Bundle ${shortId(it.shownId)} · ${downloadedText(it.downloadedAtMs, nowMs)}",
                            isRunning = it.bundleId == state.storedSessionBundleId,
                        )
                    },
                downloadedFooter =
                    if (history.isEmpty()) {
                        EMPTY_DOWNLOADED
                    } else {
                        "${history.size} of ${HotUpdaterSandboxShelf.LIMIT}" +
                            if (state.downloadedBytes > 0) " · ${sizeText(state.downloadedBytes)}" else ""
                    },
                previewHint = if (state.hasServerConfig) null else NO_SERVER,
                canEnterChannel = state.hasServerConfig && state.phase !is HotUpdaterSandboxPhase.Working,
            )
        }

        fun downloadedText(
            atMs: Long,
            nowMs: Long,
        ): String {
            val minutes = (nowMs - atMs).coerceAtLeast(0) / 60_000
            return when {
                minutes < 1 -> "downloaded just now"
                minutes < 60 -> "downloaded $minutes min ago"
                minutes < 1440 -> "downloaded ${minutes / 60} h ago"
                minutes < 2880 -> "downloaded 1 day ago"
                else -> "downloaded ${minutes / 1440} days ago"
            }
        }

        /** Decimal units, as the system shows file sizes. */
        fun sizeText(bytes: Long): String {
            if (bytes < 1_000_000) return "${maxOf(1, bytes / 1000)} KB"
            val megabytes = bytes / 1_000_000.0
            return if (megabytes < 10) String.format(java.util.Locale.US, "%.1f MB", megabytes) else "${Math.round(megabytes)} MB"
        }

        /** `019a3f…c2`, or the whole ID when it's short. */
        fun shortId(bundleId: String): String = if (bundleId.length > 10) "${bundleId.take(6)}…${bundleId.takeLast(2)}" else bundleId

        private fun bigRow(
            state: HotUpdaterSandboxState,
            isOverApp: Boolean,
            runningDevServerHost: String?,
        ): BigRow {
            if (isOverApp && runningDevServerHost != null) {
                return BigRow("Running", "Reload", "Running the dev server", runningDevServerHost, Action.RELOAD_DEV_SERVER)
            }
            state.storedSessionBundleId?.let { stored ->
                val entry = state.downloaded.firstOrNull { it.bundleId == stored }
                val channel = entry?.channel?.let { " $it" }.orEmpty()
                val shown = entry?.shownId ?: stored
                // Its deploy message, as a running row shows one, or its bundle.
                val detail = entry?.message ?: "Bundle ${shortId(shown)}"
                return BigRow("Running", "Reload", "Running stored$channel", detail, Action.RELOAD_APP, showsBack = true)
            }
            val selection =
                state.selection
                    ?: return BigRow(
                        if (isOverApp) "Running" else "Current bundle",
                        if (isOverApp) "Reload" else "Open",
                        null,
                        null,
                        if (isOverApp) Action.RELOAD_APP else Action.OPEN,
                    )
            if (isOverApp) {
                return runningRow(
                    selection,
                    state.runningBundleId ?: selection.bundleId,
                    state.details?.builtInBundleId,
                    state.runningMessage,
                )
            }
            val bundleId = selection.bundleId
            if (selection.isBuiltIn || bundleId == null) {
                return BigRow(
                    "Current bundle",
                    "Open built-in bundle",
                    "The bundle this build shipped with",
                    "Channel ${selection.channel}",
                    Action.OPEN,
                )
            }
            return BigRow(
                "Current bundle",
                "Open ${selection.channel}",
                state.selectedMessage,
                "Bundle ${shortId(bundleId)}",
                Action.OPEN,
            )
        }

        /** Running is what this process's launch runs, and the selection is the next one. */
        private fun runningRow(
            next: HotUpdaterSandboxSelection,
            running: String?,
            builtIn: String?,
            message: String?,
        ): BigRow {
            val runsBuiltIn = running == builtIn
            if (next.bundleId == running) {
                return BigRow(
                    "Running",
                    "Reload",
                    if (runsBuiltIn) "Running the built-in bundle" else "Running ${next.channel}",
                    if (runsBuiltIn) "Channel ${next.channel}" else message ?: "Bundle ${shortId(running.orEmpty())}",
                    Action.RELOAD_APP,
                )
            }
            // The built-in bundle is next and another runs: the reload opens it.
            if (next.isBuiltIn) {
                return BigRow(
                    "Current bundle",
                    "Open built-in bundle",
                    "The bundle this build shipped with",
                    "Running bundle ${shortId(running.orEmpty())}",
                    Action.OPEN_OVER_APP,
                )
            }
            return BigRow(
                "Running",
                "Reload",
                if (runsBuiltIn) "Running the built-in bundle" else "Running bundle ${shortId(running.orEmpty())}",
                "Next launch: ${if (next.isBuiltIn) "the built-in bundle" else "bundle ${shortId(next.bundleId.orEmpty())}"}",
                Action.RELOAD_APP,
            )
        }

        private fun banner(
            lastLaunch: HotUpdaterSandboxLastLaunch,
            state: HotUpdaterSandboxState,
        ): Banner {
            val selection = state.selection
            val selectedId = selection?.bundleId

            /** A channel only when this device recorded that bundle on it. */
            fun name(bundleId: String): String =
                when {
                    bundleId == state.details?.builtInBundleId -> "the built-in bundle"
                    else -> state.downloaded.firstOrNull { it.bundleId == bundleId }?.channel ?: "bundle ${shortId(bundleId)}"
                }

            /** A channel keeps its spelling at the start of a sentence. */
            fun subject(bundleId: String): String {
                val text = name(bundleId)
                return if (state.downloaded.any { it.channel == text }) text else text.replaceFirstChar(Char::uppercase)
            }

            val crashed = subject(lastLaunch.bundleId)
            val target = name(lastLaunch.rolledBackToBundleId ?: selectedId ?: lastLaunch.bundleId)
            return when (lastLaunch.kind) {
                HotUpdaterSandboxLastLaunch.Kind.CRASHED_BEFORE_CONTENT ->
                    Banner("$crashed crashed before its first screen. The device rolled back to $target.", false)
                HotUpdaterSandboxLastLaunch.Kind.ENDED_BEFORE_CONTENT ->
                    Banner("$crashed didn't reach its first screen. The device rolled back to $target.", false)
                HotUpdaterSandboxLastLaunch.Kind.CRASHED ->
                    if (selection == null || selectedId == lastLaunch.bundleId) {
                        Banner("$crashed crashed on its last launch, and it's still selected.", selection?.isBuiltIn != true)
                    } else {
                        Banner(
                            "$crashed crashed on its last launch. ${subject(selectedId.orEmpty())} is selected now.",
                            false,
                        )
                    }
            }
        }

        private fun status(phase: HotUpdaterSandboxPhase): Status? =
            when (phase) {
                is HotUpdaterSandboxPhase.Working ->
                    when (phase.step) {
                        HotUpdaterSandboxStep.PREFLIGHT, HotUpdaterSandboxStep.CHECK -> Status("Checking ${phase.target}…", null)
                        HotUpdaterSandboxStep.RESET -> Status("Removing downloaded bundles…", null)
                        HotUpdaterSandboxStep.DOWNLOAD -> {
                            val progress = phase.progress ?: 0.0
                            Status("Downloading ${phase.target}… ${(progress * 100).toInt()}%", progress)
                        }
                    }
                is HotUpdaterSandboxPhase.WaitingForServer ->
                    if (phase.checking) {
                        Status("Checking ${phase.link.channel}…", null)
                    } else {
                        Status(
                            "${phase.link.channel} needs an answer from your update server first. Open the app so it can check for updates.",
                            null,
                        )
                    }
                else -> null
            }
    }
}

/** The Info tab's rows. */
internal data class HotUpdaterSandboxInfoModel(
    val build: List<Row>,
    val bundle: List<Row>,
) {
    data class Row(
        val name: String,
        val value: String,
    )

    companion object {
        /**
         * A license file's text as paragraphs that wrap to the screen: the file's
         * hard line breaks and dashed rules go, and a heading in capitals keeps its
         * own line.
         */
        fun reflow(text: String): String {
            val paragraphs = mutableListOf<String>()
            val block = mutableListOf<String>()

            fun flush() {
                if (block.isEmpty()) return
                val first = block.first()
                if (block.size > 1 && first.lowercase() != first && first.uppercase() == first) {
                    paragraphs += first
                    block.removeAt(0)
                }
                paragraphs += block.joinToString(" ")
                block.clear()
            }
            for (line in text.replace("\r\n", "\n").split("\n")) {
                val trimmed = line.trim()
                when {
                    trimmed.isEmpty() -> flush()
                    trimmed.all { it == '-' } -> Unit
                    else -> block += trimmed
                }
            }
            flush()
            return paragraphs.joinToString("\n\n")
        }

        fun of(
            state: HotUpdaterSandboxState,
            version: String,
            configuration: String,
            isOverApp: Boolean = false,
            runningDevServerHost: String? = null,
        ): HotUpdaterSandboxInfoModel {
            val selection = state.selection
            val details = state.details
            // Over the app, what it runs. Before it starts, what opens: the selection.
            val shown = (if (isOverApp) state.runningBundleId else null) ?: selection?.bundleId
            val current =
                when {
                    runningDevServerHost != null -> "Dev server"
                    state.storedSessionBundleId != null -> {
                        val stored = state.storedSessionBundleId
                        val shown = state.downloaded.firstOrNull { it.bundleId == stored }?.shownId ?: stored
                        "Stored ${HotUpdaterSandboxHomeModel.shortId(shown)}"
                    }
                    shown == null -> ""
                    shown == details?.builtInBundleId -> "Built-in"
                    else -> HotUpdaterSandboxHomeModel.shortId(shown)
                }
            return HotUpdaterSandboxInfoModel(
                build =
                    listOf(
                        Row("Version", version),
                        Row("Configuration", configuration),
                        Row("Fingerprint", details?.fingerprintHash?.let(HotUpdaterSandboxHomeModel::shortId) ?: "None"),
                        Row("Built-in bundle", details?.builtInBundleId?.let(HotUpdaterSandboxHomeModel::shortId).orEmpty()),
                        Row("Default channel", selection?.defaultChannel.orEmpty()),
                    ),
                bundle =
                    listOf(
                        Row("Channel", selection?.channel.orEmpty()),
                        Row("Current", current),
                        Row("Pending", details?.pendingBundleId?.let(HotUpdaterSandboxHomeModel::shortId) ?: "None"),
                    ),
            )
        }
    }
}
