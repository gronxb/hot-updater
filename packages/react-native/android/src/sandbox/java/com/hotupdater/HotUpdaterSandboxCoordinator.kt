package com.hotupdater

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** What a check of the target channel did. */
internal sealed class HotUpdaterSandboxStaged {
    /** The update is staged or committed: `bundleId` is what a launch selects, null for the built-in bundle. */
    data class Update(
        val bundleId: String?,
    ) : HotUpdaterSandboxStaged()

    /** The channel has nothing newer for this build. */
    object NoUpdate : HotUpdaterSandboxStaged()

    /** Another check or reset replaced the selection first. */
    object Superseded : HotUpdaterSandboxStaged()
}

/** What the channel and bundle are now, as storage says, never as the UI assumes. */
internal data class HotUpdaterSandboxSelection(
    val channel: String,
    val defaultChannel: String,
    /** The bundle a launch selects; null or the build's ID is the built-in bundle. */
    val bundleId: String?,
    val isBuiltIn: Boolean,
)

/** Everything the coordinator asks of the SDK and the device. */
internal interface HotUpdaterSandboxHost {
    /** The fingerprint this build embeds, or null without one. */
    fun fingerprintHash(): String?

    /** Whether the app's JavaScript left a server config: a server answered one of its checks. */
    fun hasServerConfig(): Boolean

    /** Settles the previous launch first, so a crash can't be read as a selection. */
    suspend fun selection(): HotUpdaterSandboxSelection

    /** Whether the target channel has a bundle this build would run. Throws when the server can't say. */
    suspend fun preflight(channel: String): Boolean

    /** Deletes downloaded bundles and returns to the default channel. */
    suspend fun reset(): Boolean

    suspend fun checkAndStage(
        channel: String,
        onProgress: (Double) -> Unit,
    ): HotUpdaterSandboxStaged
}

/** What outlives the process. */
internal interface HotUpdaterSandboxStore {
    /** The unanswered links, oldest first. */
    var pendingLinks: List<String>

    fun recordSelected(selection: HotUpdaterSandboxSelection)

    fun recordOpened(selection: HotUpdaterSandboxSelection)
}

internal enum class HotUpdaterSandboxStep { PREFLIGHT, RESET, CHECK, DOWNLOAD }

internal sealed class HotUpdaterSandboxRefusal {
    data class Unreadable(
        val url: String,
    ) : HotUpdaterSandboxRefusal()

    /** The channel's bundles need another native build. */
    data class OtherFingerprint(
        val link: HotUpdaterSandboxLink,
        val buildFingerprintHash: String?,
    ) : HotUpdaterSandboxRefusal()

    /** Something typed isn't a channel a release can target. */
    data class InvalidChannel(
        val channel: String,
    ) : HotUpdaterSandboxRefusal()
}

internal sealed class HotUpdaterSandboxFailure {
    /** The target has no bundle for this build. */
    object NoBundle : HotUpdaterSandboxFailure()

    object ResetFailed : HotUpdaterSandboxFailure()

    /** Another check or a reset changed the selection during the switch. */
    object Superseded : HotUpdaterSandboxFailure()

    /** A request failed, or the SDK refused. */
    data class Error(
        val message: String,
    ) : HotUpdaterSandboxFailure()
}

internal sealed class HotUpdaterSandboxPhase {
    object Idle : HotUpdaterSandboxPhase()

    /** A link waits for a person to accept it. It names [link]'s channel. */
    data class Confirming(
        val link: HotUpdaterSandboxLink,
    ) : HotUpdaterSandboxPhase()

    /** A link waits for a server to answer one of the app's checks. */
    data class WaitingForServer(
        val link: HotUpdaterSandboxLink,
    ) : HotUpdaterSandboxPhase()

    data class Refused(
        val refusal: HotUpdaterSandboxRefusal,
    ) : HotUpdaterSandboxPhase()

    data class Working(
        val operationId: Long,
        val target: String,
        val step: HotUpdaterSandboxStep,
        val progress: Double? = null,
    ) : HotUpdaterSandboxPhase()

    /** [selection] is what storage holds now. After a reset, that's the built-in bundle. */
    data class Failed(
        val operationId: Long,
        val target: String,
        val step: HotUpdaterSandboxStep,
        val failure: HotUpdaterSandboxFailure,
        val selection: HotUpdaterSandboxSelection,
    ) : HotUpdaterSandboxPhase()
}

/** What the screen renders. */
internal data class HotUpdaterSandboxState(
    val selection: HotUpdaterSandboxSelection?,
    val hasServerConfig: Boolean,
    val phase: HotUpdaterSandboxPhase,
    /** Links behind the one in [phase], each asked in turn. */
    val queuedLinks: Int,
)

/**
 * The one owner of a channel switch: fingerprint check, confirmation for a link,
 * catalog preflight, reset, the SDK's check and update, then opening the app.
 * One switch runs at a time, and a row, a typed channel or a reset can't start
 * while one does; a link queues for its own confirmation. Each switch has an
 * operation ID, so what arrives after it ended changes nothing. All of it runs
 * on the [scope]'s thread, the main thread in the app; the UI only observes
 * [state] and calls these actions.
 */
internal class HotUpdaterSandboxCoordinator(
    private val host: HotUpdaterSandboxHost,
    private val store: HotUpdaterSandboxStore,
    private val scope: CoroutineScope,
    /**
     * Opens the app: on [open] with `switched` false, or after a switch. `fixed`
     * is true when this process had already fixed its launch, so only a restart
     * can apply the switch.
     */
    private val openApp: (switched: Boolean, fixed: Boolean) -> Unit,
    private val log: (String) -> Unit = {},
) {
    private val listeners = LinkedHashSet<(HotUpdaterSandboxState) -> Unit>()
    private val queue = ArrayList(store.pendingLinks)
    private var nextOperationId = 1L
    private var retryTarget: String? = null
    private var linkInFlight: String? = null

    /** A finished switch that opens the app once the links queued behind it are answered. */
    private var switchToOpen: Boolean? = null

    var state =
        HotUpdaterSandboxState(
            selection = null,
            hasServerConfig = false,
            phase = HotUpdaterSandboxPhase.Idle,
            queuedLinks = 0,
        )
        private set

    /** Calls [listener] now and at every change, until the returned function runs. */
    fun observe(listener: (HotUpdaterSandboxState) -> Unit): () -> Unit {
        listeners += listener
        listener(state)
        return { listeners -= listener }
    }

    /** Reads what storage holds, and asks about the oldest unanswered link. */
    fun refresh() {
        scope.launch {
            val selection = host.selection()
            publish(state.copy(selection = selection, hasServerConfig = host.hasServerConfig()))
            pump()
        }
    }

    /** A link from any source. The same URL already waiting or running counts once. */
    fun receiveLink(url: String) {
        if (url == linkInFlight || queue.contains(url)) {
            log("link deduped")
            return
        }
        queue += url
        persist()
        pump()
    }

    /** Accepts the link in [HotUpdaterSandboxPhase.Confirming]. */
    fun confirmLink() {
        val phase = state.phase as? HotUpdaterSandboxPhase.Confirming ?: return
        linkInFlight = phase.link.url
        begin(phase.link.channel)
    }

    /** Closes a declined link, a refusal, or a failure, and asks about the next link. */
    fun dismiss() {
        when (val phase = state.phase) {
            is HotUpdaterSandboxPhase.Confirming -> remove(phase.link.url)
            is HotUpdaterSandboxPhase.WaitingForServer -> remove(phase.link.url)
            is HotUpdaterSandboxPhase.Refused -> Unit
            is HotUpdaterSandboxPhase.Failed -> retryTarget = null
            HotUpdaterSandboxPhase.Idle, is HotUpdaterSandboxPhase.Working -> return
        }
        publish(state.copy(phase = HotUpdaterSandboxPhase.Idle))
        pump()
        openSwitchIfAnswered()
    }

    /**
     * A row or a typed channel: no confirmation, since a person chose it here.
     * A full link pasted in is a link, with the same checks as a scanned one.
     * Returns false while another switch runs.
     */
    fun switchTo(entry: String): Boolean {
        val text = entry.trim()
        if (text.contains("://")) {
            receiveLink(text)
            return true
        }
        if (!canStart()) return false
        if (!HotUpdaterSandboxLink.isChannelName(text)) {
            publish(state.copy(phase = HotUpdaterSandboxPhase.Refused(HotUpdaterSandboxRefusal.InvalidChannel(text))))
            return true
        }
        begin(text)
        return true
    }

    /** Back to the built-in bundle: what a failed switch leaves, on purpose. Returns false while a switch runs. */
    fun resetToBuiltIn(): Boolean {
        if (!canStart()) return false
        val operationId = nextOperationId++
        // Taken now, so nothing else can start while the selection is read.
        publish(state.copy(phase = HotUpdaterSandboxPhase.Working(operationId, "", HotUpdaterSandboxStep.RESET)))
        scope.launch {
            val target = host.selection().defaultChannel
            publish(state.copy(phase = HotUpdaterSandboxPhase.Working(operationId, target, HotUpdaterSandboxStep.RESET)))
            val reset = attempt(operationId, target, HotUpdaterSandboxStep.RESET) { host.reset() } ?: return@launch
            if (!reset) {
                fail(operationId, target, HotUpdaterSandboxStep.RESET, HotUpdaterSandboxFailure.ResetFailed)
                return@launch
            }
            finish(operationId)
        }
        return true
    }

    /** Runs the failed switch again from its preflight. */
    fun retry() {
        val phase = state.phase as? HotUpdaterSandboxPhase.Failed ?: return
        begin(retryTarget ?: phase.target)
    }

    /** Opens the app on what's selected, when no switch or question stands in the way. */
    fun open() {
        scope.launch {
            val selection = host.selection()
            store.recordOpened(selection)
            publish(state.copy(selection = selection))
            openApp(false, false)
        }
    }

    private fun canStart() = state.phase is HotUpdaterSandboxPhase.Idle || state.phase is HotUpdaterSandboxPhase.Failed

    private fun begin(target: String) {
        val operationId = nextOperationId++
        retryTarget = target
        publish(state.copy(phase = HotUpdaterSandboxPhase.Working(operationId, target, HotUpdaterSandboxStep.PREFLIGHT)))
        scope.launch { run(operationId, target) }
    }

    private suspend fun run(
        operationId: Long,
        target: String,
    ) {
        val before = host.selection()
        val toDefault = target == before.defaultChannel
        val hasBundle = attempt(operationId, target, HotUpdaterSandboxStep.PREFLIGHT) { host.preflight(target) } ?: return
        // A preflight that found nothing leaves everything downloaded in place.
        if (!hasBundle && !toDefault) {
            fail(operationId, target, HotUpdaterSandboxStep.PREFLIGHT, HotUpdaterSandboxFailure.NoBundle)
            return
        }
        if (before.channel != target) {
            step(operationId, target, HotUpdaterSandboxStep.RESET)
            val reset = attempt(operationId, target, HotUpdaterSandboxStep.RESET) { host.reset() } ?: return
            if (!reset) {
                fail(operationId, target, HotUpdaterSandboxStep.RESET, HotUpdaterSandboxFailure.ResetFailed)
                return
            }
        }
        step(operationId, target, HotUpdaterSandboxStep.CHECK)
        val staged =
            attempt(operationId, target, HotUpdaterSandboxStep.CHECK) {
                host.checkAndStage(target) { progress ->
                    scope.launch { reportProgress(operationId, target, progress) }
                }
            } ?: return
        when (staged) {
            HotUpdaterSandboxStaged.Superseded -> {
                fail(operationId, target, HotUpdaterSandboxStep.CHECK, HotUpdaterSandboxFailure.Superseded)
                return
            }
            HotUpdaterSandboxStaged.NoUpdate -> {
                // The channel is what the device left it on: nothing newer is the success.
                if (!toDefault && before.channel != target) {
                    fail(operationId, target, HotUpdaterSandboxStep.CHECK, HotUpdaterSandboxFailure.NoBundle)
                    return
                }
            }
            is HotUpdaterSandboxStaged.Update -> {
                // A check from the running app may have switched channels between the SDK's steps.
                if (host.selection().channel != target) {
                    fail(operationId, target, HotUpdaterSandboxStep.CHECK, HotUpdaterSandboxFailure.Superseded)
                    return
                }
            }
        }
        val expected = (staged as? HotUpdaterSandboxStaged.Update)?.bundleId
        finish(operationId, expected)
    }

    private suspend fun finish(
        operationId: Long,
        expectedBundleId: String? = null,
    ) {
        linkInFlight?.let { url ->
            linkInFlight = null
            queue -= url
            persist()
        }
        retryTarget = null
        val selection = host.selection()
        store.recordSelected(selection)
        publish(state.copy(selection = selection, phase = HotUpdaterSandboxPhase.Idle))
        log("operation $operationId selected ${selection.channel} ${selection.bundleId}")
        // Before React Native starts, a selection reads what the switch staged.
        // A different answer means this process already fixed its launch.
        switchToOpen = expectedBundleId != null && selection.bundleId != expectedBundleId
        pump()
        openSwitchIfAnswered()
    }

    private fun openSwitchIfAnswered() {
        val fixed = switchToOpen ?: return
        if (state.phase !is HotUpdaterSandboxPhase.Idle) return
        switchToOpen = null
        state.selection?.let(store::recordOpened)
        openApp(true, fixed)
    }

    private fun step(
        operationId: Long,
        target: String,
        step: HotUpdaterSandboxStep,
    ) {
        publish(state.copy(phase = HotUpdaterSandboxPhase.Working(operationId, target, step)))
    }

    private fun reportProgress(
        operationId: Long,
        target: String,
        progress: Double,
    ) {
        val phase = state.phase as? HotUpdaterSandboxPhase.Working ?: return
        if (phase.operationId != operationId) return
        publish(state.copy(phase = HotUpdaterSandboxPhase.Working(operationId, target, HotUpdaterSandboxStep.DOWNLOAD, progress)))
    }

    /** Runs a step: on failure, the failure is shown and the result is null. */
    private suspend fun <T : Any> attempt(
        operationId: Long,
        target: String,
        step: HotUpdaterSandboxStep,
        block: suspend () -> T,
    ): T? =
        try {
            block()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            fail(operationId, target, step, HotUpdaterSandboxFailure.Error(error.message ?: error.toString()))
            null
        }

    private suspend fun fail(
        operationId: Long,
        target: String,
        step: HotUpdaterSandboxStep,
        failure: HotUpdaterSandboxFailure,
    ) {
        linkInFlight?.let { url ->
            linkInFlight = null
            queue -= url
            persist()
        }
        val selection = host.selection()
        store.recordSelected(selection)
        publish(
            state.copy(
                selection = selection,
                phase = HotUpdaterSandboxPhase.Failed(operationId, target, step, failure, selection),
            ),
        )
    }

    /** Asks about the oldest link, unless something is already on screen. */
    private fun pump() {
        if (state.phase !is HotUpdaterSandboxPhase.Idle && state.phase !is HotUpdaterSandboxPhase.WaitingForServer) {
            publish(state)
            return
        }
        // A link waiting for a server is asked about again from scratch, so its
        // fingerprint is read again after a restart too.
        val url = queue.firstOrNull()
        if (url == null) {
            publish(state.copy(phase = HotUpdaterSandboxPhase.Idle))
            return
        }
        val link = HotUpdaterSandboxLink.parse(url)
        if (link == null) {
            remove(url)
            publish(state.copy(phase = HotUpdaterSandboxPhase.Refused(HotUpdaterSandboxRefusal.Unreadable(url))))
            return
        }
        val fingerprintHash = host.fingerprintHash()
        if (fingerprintHash != link.fingerprintHash) {
            remove(url)
            publish(
                state.copy(
                    phase =
                        HotUpdaterSandboxPhase.Refused(
                            HotUpdaterSandboxRefusal.OtherFingerprint(link, fingerprintHash),
                        ),
                ),
            )
            return
        }
        val hasServerConfig = host.hasServerConfig()
        publish(
            state.copy(
                hasServerConfig = hasServerConfig,
                phase =
                    if (hasServerConfig) {
                        HotUpdaterSandboxPhase.Confirming(link)
                    } else {
                        HotUpdaterSandboxPhase.WaitingForServer(link)
                    },
            ),
        )
    }

    private fun remove(url: String) {
        queue -= url
        persist()
    }

    private fun persist() {
        store.pendingLinks = queue.toList()
    }

    private fun publish(next: HotUpdaterSandboxState) {
        val inPhase =
            when (val phase = next.phase) {
                is HotUpdaterSandboxPhase.Confirming -> phase.link.url
                is HotUpdaterSandboxPhase.WaitingForServer -> phase.link.url
                else -> linkInFlight
            }
        state = next.copy(queuedLinks = queue.count { it != inPhase })
        listeners.toList().forEach { it(state) }
    }
}
