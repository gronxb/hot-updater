package com.hotupdater

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID
import java.util.concurrent.Executors
import kotlin.coroutines.CoroutineContext

/** What a check of the target channel did. */
internal sealed class HotUpdaterSandboxStaged {
    /** The update is staged or committed: `bundleId` is what a launch selects, null for the built-in bundle. */
    data class Update(
        val bundleId: String?,
        val message: String? = null,
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

/**
 * The bundle the next launch selects. The SDK's own read answers what this
 * process runs once it has fixed a launch, a bundle a reset may have deleted by
 * then, so after a launch the answer is what storage holds as active.
 *
 * @param runningBundleId the OTA this process launched; null before a launch, or
 *   after one of the built-in bundle
 * @param launchBundleId the SDK's read: the launched bundle, or before a launch the
 *   bundle one would pick; null is the built-in bundle
 * @param activeBundleId the stored active selection's bundle, or null
 */
internal fun hotUpdaterSandboxNextLaunchBundleId(
    runningBundleId: String?,
    launchBundleId: String?,
    activeBundleId: String?,
    builtInBundleId: String,
): String =
    if (runningBundleId == null && launchBundleId != null) {
        launchBundleId
    } else {
        activeBundleId ?: builtInBundleId
    }

/** Everything the coordinator asks of the SDK and the device. */
internal interface HotUpdaterSandboxHost {
    /** The fingerprint this build embeds, or null without one. */
    fun fingerprintHash(): String?

    /**
     * Whether this process runs a dev server's JavaScript or a stored bundle, where
     * nothing can change the normal selection.
     */
    val isInSession: Boolean
        get() = false

    /** The stored bundle this process runs, or null. */
    val storedSessionBundleId: String?
        get() = null

    /**
     * Hands a stored bundle to a new process, which replaces this one, under
     * [handoff]: a nonce the relaunch and [abandonStoredSession] each try to take.
     * Returns whether the handoff went out. A cold launch is back on the normal selection.
     */
    fun startStoredSession(
        bundle: HotUpdaterSandboxStoredBundle,
        handoff: String,
    ): Boolean = false

    /**
     * Calls off [handoff] by taking it. True when the call-off took it, so nothing
     * relaunches; false when the relaunch took it first, now or on any later call.
     */
    fun abandonStoredSession(handoff: String): Boolean = true

    /** Ends the session: a new process, on the first screen. */
    fun exitSession() = Unit

    /** Whether the app's JavaScript left a server config: a server answered one of its checks. */
    fun hasServerConfig(): Boolean

    /** What the next launch selects, as storage holds it. Settles the previous launch first, so a crash can't be read as a selection. */
    suspend fun selection(): HotUpdaterSandboxSelection

    /**
     * What this process's launch runs, or before one, what it would pick. It differs
     * from a staged bundle once the launch is fixed, so only a restart applies a switch.
     */
    suspend fun launchBundleId(): String? = selection().bundleId

    /** Whether the app is up under the screen, so opening it starts nothing. */
    fun isAppRunning(): Boolean = false

    /** Whether the target channel has a bundle this build would run. Throws when the server can't say. */
    suspend fun preflight(channel: String): Boolean

    /** What the last launch left: read, never a request. Settled reads come after [selection]. */
    fun launchEvidence(): HotUpdaterSandboxLaunchEvidence

    /** What the build and the SDK's store hold: read, never a request. */
    fun details(): HotUpdaterSandboxDetails

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

    /** What the last launch left, until a person moved on from it. */
    var lastLaunch: HotUpdaterSandboxLastLaunch?
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

    /** A stored bundle runs: the way back is to the current bundle. */
    object InStoredSession : HotUpdaterSandboxFailure()

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
    val details: HotUpdaterSandboxDetails? = null,
    val lastLaunch: HotUpdaterSandboxLastLaunch? = null,
    /** What the sandbox's switches downloaded, newest first. */
    val downloaded: List<HotUpdaterSandboxShelfEntry> = emptyList(),
    /** What the stored copies take. */
    val downloadedBytes: Long = 0,
    /** The stored bundle this process runs, or null. */
    val storedSessionBundleId: String? = null,
    /** The deploy message of the selected bundle, when this device knows it. */
    val selectedMessage: String? = null,
    /** What this process's launch runs, or before one, what it would pick; `selection` is the next launch. */
    val runningBundleId: String? = null,
    val runningMessage: String? = null,
)

/**
 * The one serialization point for what changes the selection or a dev session in
 * this process: a switch (a preview link, a channel, the built-in bundle) or a dev
 * server connection (connect, Reload). Each holds it across all its suspensions,
 * and whichever comes second is refused, never queued behind the other.
 */
internal class HotUpdaterSandboxLock {
    enum class Holder { SWITCHING, DEV_SERVER }

    @Volatile
    var holder: Holder? = null
        private set

    @Synchronized
    fun take(who: Holder): Boolean {
        if (holder != null) return false
        holder = who
        return true
    }

    @Synchronized
    fun release(who: Holder) {
        if (holder == who) holder = null
    }

    companion object {
        val process = HotUpdaterSandboxLock()
    }
}

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
    private val shelf: HotUpdaterSandboxShelf,
    private val scope: CoroutineScope,
    /**
     * Opens the app: on [open] with `switched` false, or after a switch. `fixed`
     * is true when this process had already fixed its launch, so only a restart
     * can apply the switch.
     */
    private val openApp: (switched: Boolean, fixed: Boolean) -> Unit,
    private val log: (String) -> Unit = {},
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val lock: HotUpdaterSandboxLock = HotUpdaterSandboxLock.process,
    /** Where the shelf's file work runs, in order, off the main thread. */
    private val shelfContext: CoroutineContext = Executors.newSingleThreadExecutor().asCoroutineDispatcher(),
) {
    /** The Downloaded list as the shelf last reported it: the screen reads only this. */
    private var downloaded = emptyList<HotUpdaterSandboxShelfEntry>()
    private var downloadedBytes = 0L

    /**
     * The stored session a row asked for, from the tap until the process that
     * replaces this one runs it: its files are checked, then it is handed off.
     * Nothing else starts meanwhile, links wait, and it is protected as the running
     * one is. A screen back in front while it's pending means the handoff didn't happen.
     */
    private var pendingStoredBundleId: String? = null

    /**
     * The nonce of the handoff that went out for [pendingStoredBundleId]. It stays
     * until the call-off takes it: a relaunch that took it is replacing this process.
     */
    private var sentHandoff: String? = null

    /** Bumped when a handoff is called off, so a check still in flight hands nothing off. */
    private var handoff = 0L

    /** What Delete, Clear, and the cap leave alone: what runs, and what is about to. */
    private val protectedBundleIds get() = setOfNotNull(host.storedSessionBundleId, pendingStoredBundleId)

    private val listeners = LinkedHashSet<(HotUpdaterSandboxState) -> Unit>()
    private val queue = ArrayList(store.pendingLinks)
    private var nextOperationId = 1L
    private var retryTarget: String? = null
    private var linkInFlight: String? = null

    /** The link a refusal on screen is about: the system can deliver a cold link twice. */
    private var refusedLink: String? = null

    /** A finished switch opens the app once the links queued behind it are answered. */
    private var switchAwaitsOpen = false

    /**
     * Whether this process's launch runs something other than what the next one
     * selects, as of the last [readSelection]: only a restart can apply that.
     */
    private var launchFixed = false

    /**
     * The bundle of the last launch a person moved on from in this process, whose
     * evidence stays readable until the process ends.
     */
    private var acknowledgedBundleId: String? = null

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

    /**
     * Reads what storage holds, and asks about the oldest unanswered link.
     * Sends no request: opening the screen costs the update server nothing.
     */
    fun refresh() {
        // A switch may be copying into the shelf: its partial copy isn't listed yet.
        val reconciling = state.phase !is HotUpdaterSandboxPhase.Working
        scope.launch {
            relist(reconciling)
            val selection = readSelection()
            publish(reading(selection, host.launchBundleId()))
            pump()
        }
    }

    /**
     * Keeps what the last launch left, for a launch that started without the
     * screen: the next screen tells it, once that launch's evidence is gone.
     */
    fun noteLastLaunch() {
        scope.launch {
            // Read first: before a launch, it settles what the previous process left.
            host.selection()
            publish(state.copy(lastLaunch = settledLastLaunch(host.launchBundleId())))
        }
    }

    /** A link from any source. The same URL already waiting or running counts once. */
    fun receiveLink(url: String) {
        if (url == linkInFlight || url == refusedLink || queue.contains(url)) {
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
        // A handoff is on its way: the link waits for it to resolve.
        if (pendingStoredBundleId != null) return
        // The link stays stored, and the first screen asks about it in the new process.
        if (host.isInSession) {
            host.exitSession()
            return
        }
        linkInFlight = phase.link.url
        begin(phase.link.channel)
    }

    /**
     * Closes a declined link, a refusal, or a failure, and asks about the next link.
     * [onAnswered] runs only if nothing is left to answer, so a screen closing itself
     * can't take the next question with it.
     */
    fun dismiss(onAnswered: (() -> Unit)? = null) {
        when (val phase = state.phase) {
            is HotUpdaterSandboxPhase.Confirming -> remove(phase.link.url)
            is HotUpdaterSandboxPhase.WaitingForServer -> remove(phase.link.url)
            is HotUpdaterSandboxPhase.Refused -> refusedLink = null
            is HotUpdaterSandboxPhase.Failed -> retryTarget = null
            HotUpdaterSandboxPhase.Idle, is HotUpdaterSandboxPhase.Working -> return
        }
        publish(state.copy(phase = HotUpdaterSandboxPhase.Idle))
        pump()
        openSwitchIfAnswered()
        if (state.phase is HotUpdaterSandboxPhase.Idle) onAnswered?.invoke()
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
            if (!takeLock(operationId, "")) return@launch
            try {
                val target = host.selection().defaultChannel
                if (refuseInSession(operationId, target)) return@launch
                publish(state.copy(phase = HotUpdaterSandboxPhase.Working(operationId, target, HotUpdaterSandboxStep.RESET)))
                val reset = attempt(operationId, target, HotUpdaterSandboxStep.RESET) { host.reset() } ?: return@launch
                if (!reset) {
                    fail(operationId, target, HotUpdaterSandboxStep.RESET, HotUpdaterSandboxFailure.ResetFailed)
                    return@launch
                }
                finish(operationId)
            } finally {
                lock.release(HotUpdaterSandboxLock.Holder.SWITCHING)
            }
        }
        return true
    }

    /** Runs the failed switch again from its preflight. */
    fun retry() {
        val phase = state.phase as? HotUpdaterSandboxPhase.Failed ?: return
        // A refusal in a stored session offers the way back instead.
        if (phase.failure == HotUpdaterSandboxFailure.InStoredSession) {
            leaveStoredSession()
            return
        }
        begin(retryTarget ?: phase.target)
    }

    /** Opens the app on what's selected, when no switch or question stands in the way. */
    fun open() {
        scope.launch {
            val selection = readSelection()
            val launched = host.launchBundleId()
            // Over a running app, opening shows what it runs: what's selected waits
            // for its launch. Before the app starts, what's selected is what opens.
            val restarts = launchFixed && !host.isAppRunning()
            // A session runs no selected bundle, so it says nothing about one.
            if (!host.isInSession) {
                recordOpened(
                    if (restarts) {
                        selection
                    } else {
                        selection.copy(bundleId = launched, isBuiltIn = selection.isBuiltIn && launched == selection.bundleId)
                    },
                )
            }
            acknowledgeLastLaunch()
            publish(reading(selection, launched))
            openApp(false, restarts)
        }
    }

    /** Runs the app again from the screen over it: the bundle a launch selects now. */
    fun reloadApp() {
        if (!canStart()) return
        host.storedSessionBundleId?.let {
            openDownloaded(it)
            return
        }
        acknowledgeLastLaunch()
        openApp(true, true)
    }

    /**
     * A Downloaded row runs its stored bundle in a new process, offline. A row
     * whose bundle isn't on this device checks its channel, as a typed one does,
     * and stays: only Delete and Clear remove a row.
     * Returns false while a switch runs.
     */
    fun openDownloaded(bundleId: String): Boolean {
        if (!canStart() || lock.holder != null) return false
        val entry = downloaded.firstOrNull { it.bundleId == bundleId } ?: return false
        pendingStoredBundleId = bundleId
        val attempt = ++handoff
        scope.launch {
            // The files are checked off the main thread.
            val bundle = withContext(shelfContext) { shelf.stored(bundleId) }
            if (attempt != handoff) return@launch
            if (bundle == null) {
                pendingStoredBundleId = null
                switchTo(entry.channel)
                return@launch
            }
            val phase = state.phase
            if (lock.holder != null || (phase !is HotUpdaterSandboxPhase.Idle && phase !is HotUpdaterSandboxPhase.Failed)) {
                letGoOfHandoff()
                return@launch
            }
            acknowledgeLastLaunch()
            publish(state.copy(phase = HotUpdaterSandboxPhase.Idle))
            log("opening stored ${entry.channel} $bundleId")
            val nonce = UUID.randomUUID().toString()
            sentHandoff = nonce
            if (!host.startStoredSession(bundle, nonce)) letGoOfHandoff()
        }
        return true
    }

    /**
     * The sandbox's screen is in front again, resumed or made anew, in this process:
     * a handoff still pending didn't happen, such as a relaunch the system kept
     * from starting. Its row can be tapped again, and links waiting are asked about.
     */
    fun resumed() {
        if (pendingStoredBundleId == null) return
        // The relaunch took its handoff first: it's replacing this process, so the guard
        // stays, on this resume and every later one. A handoff not sent yet is called off
        // by the bump below, which its check in flight sees.
        val sent = sentHandoff
        if (sent != null && !host.abandonStoredSession(sent)) {
            log("a stored session's relaunch is under way")
            return
        }
        handoff++
        log("a stored session's relaunch didn't happen")
        letGoOfHandoff()
    }

    private fun letGoOfHandoff() {
        pendingStoredBundleId = null
        sentHandoff = null
        publish(listed(state))
        pump()
    }

    /** Back to what the normal selection runs. */
    fun leaveStoredSession() {
        if (host.storedSessionBundleId == null) return
        if (state.phase is HotUpdaterSandboxPhase.Failed) dismiss()
        host.exitSession()
    }

    /** Removes a row and its files. The running one stays. */
    fun deleteDownloaded(bundleId: String) {
        if (bundleId in protectedBundleIds) return
        scope.launch {
            withContext(shelfContext) { shelf.remove(bundleId) }
            relist(reconciling = false)
        }
    }

    /** A person moved on from what the last launch left, so it's not told again. */
    fun acknowledgeLastLaunch() {
        val shown = store.lastLaunch ?: return
        acknowledgedBundleId = shown.bundleId
        store.lastLaunch = null
        publish(state.copy(lastLaunch = null))
    }

    /** Removes every row and its files but the running one: they're only on this device. */
    fun clearDownloaded() {
        val kept = protectedBundleIds
        scope.launch {
            withContext(shelfContext) { shelf.clear(kept) }
            relist(reconciling = false)
        }
    }

    /** Takes the shelf's list and size from its thread, and shows them. */
    private suspend fun relist(reconciling: Boolean) {
        val (entries, bytes) =
            withContext(shelfContext) {
                if (reconciling) shelf.reconcile()
                shelf.entries to shelf.totalBytes()
            }
        downloaded = entries
        downloadedBytes = bytes
        publish(listed(state))
    }

    /** The Downloaded list as the shelf last reported it. */
    private fun listed(base: HotUpdaterSandboxState): HotUpdaterSandboxState {
        val entries = downloaded
        return base.copy(
            downloaded = entries,
            downloadedBytes = downloadedBytes,
            storedSessionBundleId = host.storedSessionBundleId,
            selectedMessage = entries.firstOrNull { it.bundleId == base.selection?.bundleId }?.message,
            runningMessage = entries.firstOrNull { it.bundleId == base.runningBundleId }?.message,
        )
    }

    /** What storage says now, with no request. */
    private fun reading(
        selection: HotUpdaterSandboxSelection,
        launched: String?,
    ): HotUpdaterSandboxState =
        listed(
            state.copy(
                selection = selection,
                runningBundleId = launched,
                hasServerConfig = host.hasServerConfig(),
                details = host.details(),
                lastLaunch = settledLastLaunch(launched),
            ),
        )

    /** Reads evidence after the host's reads, which settled the previous launch. */
    private fun settledLastLaunch(launched: String?): HotUpdaterSandboxLastLaunch? {
        val derived = HotUpdaterSandboxLastLaunch.derive(host.launchEvidence(), launched)
        if (derived != null && derived.bundleId != acknowledgedBundleId) {
            store.lastLaunch = derived
        }
        return store.lastLaunch
    }

    private fun recordOpened(selection: HotUpdaterSandboxSelection) {
        store.recordOpened(selection)
    }

    private fun canStart() =
        pendingStoredBundleId == null && (state.phase is HotUpdaterSandboxPhase.Idle || state.phase is HotUpdaterSandboxPhase.Failed)

    private fun begin(target: String) {
        val operationId = nextOperationId++
        retryTarget = target
        publish(state.copy(phase = HotUpdaterSandboxPhase.Working(operationId, target, HotUpdaterSandboxStep.PREFLIGHT)))
        scope.launch { run(operationId, target) }
    }

    /** A switch holds the lock for all of its steps, so no dev server connects between them. */
    private suspend fun takeLock(
        operationId: Long,
        target: String,
    ): Boolean {
        if (lock.take(HotUpdaterSandboxLock.Holder.SWITCHING)) return true
        fail(
            operationId,
            target,
            HotUpdaterSandboxStep.PREFLIGHT,
            HotUpdaterSandboxFailure.Error("A dev server is connecting. Wait for it, then try again."),
        )
        return false
    }

    /**
     * A session's native state is the session's, so a switch waits for its end.
     * Asked again after every suspension, before a step that changes the selection.
     */
    private suspend fun refuseInSession(
        operationId: Long,
        target: String,
        step: HotUpdaterSandboxStep = HotUpdaterSandboxStep.PREFLIGHT,
    ): Boolean {
        if (!host.isInSession) return false
        fail(
            operationId,
            target,
            step,
            if (host.storedSessionBundleId != null) {
                HotUpdaterSandboxFailure.InStoredSession
            } else {
                HotUpdaterSandboxFailure.Error("The dev server is running. Exit it, then try again.")
            },
        )
        return true
    }

    private suspend fun run(
        operationId: Long,
        target: String,
    ) {
        if (!takeLock(operationId, target)) return
        try {
            runHolding(operationId, target)
        } finally {
            lock.release(HotUpdaterSandboxLock.Holder.SWITCHING)
        }
    }

    private suspend fun runHolding(
        operationId: Long,
        target: String,
    ) {
        if (refuseInSession(operationId, target)) return
        val before = host.selection()
        val toDefault = target == before.defaultChannel
        val hasBundle = attempt(operationId, target, HotUpdaterSandboxStep.PREFLIGHT) { host.preflight(target) } ?: return
        // A preflight that found nothing leaves everything downloaded in place.
        if (!hasBundle && !toDefault) {
            fail(operationId, target, HotUpdaterSandboxStep.PREFLIGHT, HotUpdaterSandboxFailure.NoBundle)
            return
        }
        if (before.channel != target) {
            if (refuseInSession(operationId, target, HotUpdaterSandboxStep.RESET)) return
            step(operationId, target, HotUpdaterSandboxStep.RESET)
            val reset = attempt(operationId, target, HotUpdaterSandboxStep.RESET) { host.reset() } ?: return
            if (!reset) {
                fail(operationId, target, HotUpdaterSandboxStep.RESET, HotUpdaterSandboxFailure.ResetFailed)
                return
            }
        }
        if (refuseInSession(operationId, target, HotUpdaterSandboxStep.CHECK)) return
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
                staged.bundleId?.let { shelve(it, target, staged.message) }
            }
        }
        finish(operationId)
    }

    /**
     * Keeps a copy of what the switch just installed, off the main thread. Main's
     * store keeps the bundle it just installed, so the copy reads it in place.
     */
    private suspend fun shelve(
        bundleId: String,
        channel: String,
        message: String?,
    ) {
        val kept = protectedBundleIds
        val now = nowMs()
        withContext(shelfContext) { shelf.add(bundleId, channel, message, now, kept) }
        relist(reconciling = false)
    }

    private suspend fun finish(operationId: Long) {
        linkInFlight?.let { url ->
            linkInFlight = null
            queue -= url
            persist()
        }
        retryTarget = null
        val selection = readSelection()
        store.recordSelected(selection)
        acknowledgeLastLaunch()
        publish(reading(selection, host.launchBundleId()).copy(phase = HotUpdaterSandboxPhase.Idle))
        log("operation $operationId selected ${selection.channel} ${selection.bundleId}")
        switchAwaitsOpen = true
        pump()
        openSwitchIfAnswered()
    }

    private fun openSwitchIfAnswered() {
        if (!switchAwaitsOpen || state.phase !is HotUpdaterSandboxPhase.Idle) return
        switchAwaitsOpen = false
        state.selection?.let(::recordOpened)
        openApp(true, launchFixed)
    }

    /** What the next launch selects, and with it whether this process's launch runs that. */
    private suspend fun readSelection(): HotUpdaterSandboxSelection {
        val selection = host.selection()
        // A session runs no selection, and only its end replaces it.
        launchFixed = !host.isInSession && host.launchBundleId() != selection.bundleId
        return selection
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
        val selection = readSelection()
        store.recordSelected(selection)
        publish(
            reading(
                selection,
                host.launchBundleId(),
            ).copy(phase = HotUpdaterSandboxPhase.Failed(operationId, target, step, failure, selection)),
        )
    }

    /** Asks about the oldest link, unless something is already on screen. */
    private fun pump() {
        // A handoff is on its way: links stay queued until it resolves.
        if (pendingStoredBundleId != null ||
            (state.phase !is HotUpdaterSandboxPhase.Idle && state.phase !is HotUpdaterSandboxPhase.WaitingForServer)
        ) {
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
            refusedLink = url
            publish(state.copy(phase = HotUpdaterSandboxPhase.Refused(HotUpdaterSandboxRefusal.Unreadable(url))))
            return
        }
        val fingerprintHash = host.fingerprintHash()
        if (fingerprintHash != link.fingerprintHash) {
            remove(url)
            refusedLink = url
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
