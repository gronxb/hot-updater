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
    val previews: List<Preview>,
    /** In place of an empty list, or above it before a server answered. */
    val previewHint: String?,
) {
    data class Banner(
        val text: String,
        /** A bundle that crashed and stays selected: the way out is a reset. */
        val offersReset: Boolean,
    )

    data class BigRow(
        val caption: String,
        val title: String,
        val subtitle: String?,
        val detail: String?,
        val isReload: Boolean,
    )

    data class Preview(
        val channel: String,
        val message: String?,
        val opened: String,
    )

    data class Status(
        val text: String,
        /** From 0 to 1 while a download reports it. */
        val progress: Double?,
    )

    companion object {
        const val HINT = "Shake the device to come back here."

        /** A row or a typed channel doesn't ask first, so this says it up front. */
        const val SWITCH_NOTE = "Opening a preview deletes downloaded bundles."
        const val RESET_NOTE = "Removes the channel switch and deletes downloaded bundles."

        fun of(
            state: HotUpdaterSandboxState,
            isOverApp: Boolean,
            runningDevServerHost: String? = null,
            nowMs: Long,
        ): HotUpdaterSandboxHomeModel {
            val previews =
                state.history
                    .filter { it.channel != state.selection?.channel }
                    .map { Preview(it.channel, it.message, HotUpdaterSandboxHistory.openedText(it.openedAtMs, nowMs)) }
            return HotUpdaterSandboxHomeModel(
                banner = state.lastLaunch?.let { banner(it, state) },
                bigRow = bigRow(state, isOverApp, runningDevServerHost),
                status = status(state.phase),
                isBusy = state.phase is HotUpdaterSandboxPhase.Working,
                previews = previews,
                previewHint =
                    when {
                        !state.hasServerConfig ->
                            "No update server yet. Previews work once your update server answers one of the app's update checks."
                        previews.isEmpty() -> "Scan a pull request's QR code, or enter its channel. It stays listed here."
                        else -> null
                    },
            )
        }

        /** `019a3f…c2`, or the whole ID when it's short. */
        fun shortId(bundleId: String): String = if (bundleId.length > 10) "${bundleId.take(6)}…${bundleId.takeLast(2)}" else bundleId

        private fun bigRow(
            state: HotUpdaterSandboxState,
            isOverApp: Boolean,
            runningDevServerHost: String?,
        ): BigRow {
            if (isOverApp && runningDevServerHost != null) {
                return BigRow("Running", "Reload", "Running the dev server", runningDevServerHost, isReload = true)
            }
            val selection =
                state.selection
                    ?: return BigRow(
                        if (isOverApp) "Running" else "Current bundle",
                        if (isOverApp) "Reload" else "Open",
                        null,
                        null,
                        isOverApp,
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
                    isReload = false,
                )
            }
            return BigRow(
                "Current bundle",
                "Open ${selection.channel}",
                state.selectedMessage,
                "Bundle ${shortId(bundleId)}",
                isReload = false,
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
                    isReload = true,
                )
            }
            return BigRow(
                "Running",
                "Reload",
                if (runsBuiltIn) "Running the built-in bundle" else "Running bundle ${shortId(running.orEmpty())}",
                "Next launch: ${if (next.isBuiltIn) "the built-in bundle" else "bundle ${shortId(next.bundleId.orEmpty())}"}",
                isReload = true,
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
                    else -> state.history.firstOrNull { it.bundleId == bundleId }?.channel ?: "bundle ${shortId(bundleId)}"
                }

            /** A channel keeps its spelling at the start of a sentence. */
            fun subject(bundleId: String): String {
                val text = name(bundleId)
                return if (state.history.any { it.channel == text }) text else text.replaceFirstChar(Char::uppercase)
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
                    Status(
                        "${phase.link.channel} needs an answer from your update server first. Open the app so it can check for updates.",
                        null,
                    )
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
