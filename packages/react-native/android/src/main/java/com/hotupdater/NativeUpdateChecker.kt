package com.hotupdater

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.MalformedURLException
import java.net.URL
import java.util.concurrent.CopyOnWriteArrayList

/*
 * The update check native code runs without JavaScript, ported from
 * checkForUpdate.ts and httpClient.ts in packages/react-native/src. It reads
 * and writes the same native state as the TurboModule, so a JavaScript check
 * and a native one agree, and queues the plugin events JavaScript replays.
 */

internal class UpdateCheckRequest(
    val url: String,
    val headers: Map<String, String>,
    val timeoutMillis: Long,
    /** "catalog" or "artifact", as `onHttpResponse` reports the request. */
    val resource: String = "catalog",
)

internal class UpdateCheckResponse(
    val status: Int,
    val statusText: String,
    headers: Map<String, String>,
    /** The body, or null when it could not be read. */
    val body: String?,
) {
    private val headers = headers.mapKeys { it.key.lowercase() }

    fun header(name: String): String? = headers[name.lowercase()]
}

/** GET requests for the check. Throws an IOException when no response arrives. */
internal interface UpdateCheckTransport {
    suspend fun get(request: UpdateCheckRequest): UpdateCheckResponse
}

internal data class ReleaseSelectionGuard(
    val catalogId: String,
    val scopeKey: String,
    val generation: Long,
    val catalogHash: String,
    val channel: String,
    val selectionContextHash: String,
)

internal class ActiveSelections(
    val activeSelection: PersistedSelection?,
    val stableSelection: PersistedSelection?,
)

/** The arguments of the native `updateBundle`, as the TurboModule parses them. */
internal data class StageBundleRequest(
    val bundleId: String,
    val channel: String,
    val manifestUrl: String,
    val manifestFileHash: String,
    val assets: Map<String, ChangedAssetDescriptor>,
    val archiveUrl: String?,
    val selection: PersistedSelection,
    /** Artifact protocol v2: where the staging asks for the URLs of the files it downloads. */
    val filesUrl: String? = null,
    /** The check's headers and timeout, which the files request repeats. */
    val requestHeaders: Map<String, String> = emptyMap(),
    val requestTimeoutMillis: Long = HttpArtifactFileResolver.DEFAULT_TIMEOUT_MS,
    /** Reports each files response as `onHttpResponse`, as the other artifact requests are. */
    val onFilesResponse: ((status: Int, body: String?) -> Unit)? = null,
)

/** The native state the check reads and writes, the same the TurboModule exposes. */
internal interface UpdateCheckState {
    fun getAppVersion(): String?

    /** The running bundle, or before React Native starts the one its launch would pick; null is the built-in bundle. */
    fun getBundleId(): String?

    fun getMinBundleId(): String

    fun getDefaultChannel(): String

    fun getChannel(): String

    fun getCohort(): String

    fun getFingerprintHash(): String?

    /** Records this check's outcome in the update log. */
    fun appendUpdateLog(event: UpdateLogEvent) {}

    fun getCrashHistory(): List<String>

    fun getActiveUpdateState(): ActiveSelections

    fun acceptReleaseCatalog(guard: ReleaseSelectionGuard): Boolean

    fun isReleaseSelectionCurrent(guard: ReleaseSelectionGuard): Boolean

    suspend fun commitReleaseSelection(selection: PersistedSelection): Boolean

    /**
     * Clears the runtime channel and restores the built-in bundle, as
     * `resetChannel` does, only while the Release selection [guard] names is
     * current: one step with the catalog checks.
     */
    suspend fun resetChannelIfSelectionCurrent(guard: ReleaseSelectionGuard): Boolean

    /** Stages a bundle, reporting its download progress from 0 to 1. */
    suspend fun updateBundle(
        request: StageBundleRequest,
        onProgress: (Double) -> Unit,
    ): UpdateBundleResult

    fun getReleaseCatalogCache(partition: String): String?

    fun setReleaseCatalogCache(
        partition: String,
        payload: String,
    ): Boolean

    fun removeReleaseCatalogCache(partition: String): Boolean

    /** The server answered [request]: main keeps it for its check after a crash, as JavaScript's checks do. */
    fun recordRecoveryRequest(request: NativeCheckRequest) {}

    fun getStorageItem(key: String): String?

    fun setStorageItem(
        key: String,
        value: String?,
    )

    /** Whether the device has no network, asked only after a failed host lookup. */
    fun isOffline(): Boolean
}

/** A request the server answered with a status the SDK does not accept. */
internal class UpdateHttpException(
    val status: Int,
    statusText: String,
) : Exception("Request failed with HTTP $status${if (statusText.isEmpty()) "" else " $statusText"}")

/** A response the SDK cannot use: a malformed or stale catalog, an artifact in another protocol, or an invalid URL. */
internal class InvalidUpdateResponseException(
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)

/** A selection that became stale is a race between checks, not a failure. */
internal class StaleReleaseCatalogException : IllegalStateException("Release catalog selection became stale before it was committed")

/**
 * Fans a staging's progress out to every caller waiting on it: values from 0
 * to 1, increasing, at most one per percent, on the downloading thread.
 */
internal class ProgressFanout {
    private val listeners = CopyOnWriteArrayList<(Double) -> Unit>()
    private var lastReported = -1.0

    fun add(listener: (Double) -> Unit) {
        listeners.add(listener)
    }

    fun remove(listener: (Double) -> Unit) {
        listeners.remove(listener)
    }

    fun report(progress: Double) {
        val value = if (progress.isNaN()) return else progress.coerceIn(0.0, 1.0)
        synchronized(this) {
            if (value <= lastReported || (value < 1.0 && value - lastReported < 0.01)) return
            lastReported = value
        }
        listeners.forEach { listener ->
            // A caller that stopped waiting while this report ran removed it.
            if (!listeners.contains(listener)) return@forEach
            try {
                listener(value)
            } catch (error: Exception) {
                Log.w("HotUpdaterCheck", "A progress listener threw", error)
            }
        }
    }
}

private val HTTP_URL = Regex("^https?://.+", RegexOption.IGNORE_CASE)

/** Throws unless [baseURL] is an absolute HTTP(S) URL with a host, as `HotUpdater.init` requires. */
internal fun requireValidBaseURL(baseURL: String) {
    val valid =
        HTTP_URL.matches(baseURL) &&
            try {
                // java.net.URL parses a hostless "https:///api"; a request needs a host.
                !URL(baseURL).host.isNullOrEmpty()
            } catch (_: MalformedURLException) {
                false
            }
    require(valid) { "Invalid baseURL: $baseURL" }
}

internal class NativeUpdateChecker(
    private val state: UpdateCheckState,
    private val transport: UpdateCheckTransport,
    private val stagingScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    companion object {
        private const val TAG = "HotUpdaterCheck"
        private const val PLATFORM = "android"
        private const val NIL_UUID = "00000000-0000-0000-0000-000000000000"

        /** The longest response body queued: the queue lives in the key-value store. */
        private const val HTTP_RESPONSE_BODY_LIMIT = 4_096
        private const val INVALID_COHORT_MESSAGE =
            "Invalid cohort. Use 1-1000 or a lowercase slug without spaces, up to ${ReleaseSelector.MAX_COHORT_LENGTH} characters."
    }

    private class StagingOutcome(
        val committed: Boolean,
    )

    private class Staging(
        val update: HotUpdaterUpdate?,
        val result: Deferred<StagingOutcome>?,
        val progress: ProgressFanout,
    )

    /** Held from a check through the staging it starts, so one runs at a time in this process. */
    private val mutex = Mutex()
    private val inFlightLock = Any()
    private var inFlight: Staging? = null

    /**
     * The channel the check or staging holding the lock requests, recorded with
     * its HTTP responses: an explicit channel is not the runtime one until the
     * switch commits.
     */
    @Volatile
    private var requestChannel: String? = null

    /** The cohort the check or staging holding the lock selected for, which its events report. */
    @Volatile
    private var requestCohort: String? = null

    /** The target the last staging committed, for another retained result of the same target. */
    @Volatile
    private var lastCommittedTargetKey: String? = null

    /**
     * The last switched-channel leave that reset the device, for another
     * retained result of the same catalog. Kept apart from
     * [lastCommittedTargetKey], which a reset clears.
     */
    @Volatile
    private var lastLeftTargetKey: String? = null

    private val events =
        NativeUpdateEventQueue(state::getStorageItem, state::setStorageItem, build = {
            NativeUpdateEventQueue.buildOf(state.getAppVersion(), state.getMinBundleId(), requestCohort ?: state.getCohort())
        })

    /** Queues each catalog and artifact response for `onHttpResponse`, as fetchUpdateResponse.ts reports it. */
    private val recordingTransport =
        object : UpdateCheckTransport {
            override suspend fun get(request: UpdateCheckRequest): UpdateCheckResponse =
                try {
                    transport.get(request).also { queueHttpResponse(request, it) }
                } catch (error: UpdateResponseBodyException) {
                    // The response arrived without its body: reported with a null body, as
                    // fetchUpdateResponse.ts does, and the request fails as it did.
                    queueHttpResponse(request, error.response)
                    throw error.cause
                }
        }
    private val catalogClient = ReleaseCatalogClient(state, recordingTransport)

    /**
     * Resets the channel once no check or staging runs. A reset deletes staged
     * bundles, so their queued downloads are dropped rather than replayed.
     */
    suspend fun resetChannel(reset: suspend () -> Boolean): Boolean =
        whenIdle {
            reset().also { reset -> if (reset) events.remove("onBundleDownloaded") }
        }

    /**
     * Runs [block] once no check or staging runs, as a channel reset must: a
     * staging that finished after the reset would save its channel again.
     */
    suspend fun <T> whenIdle(block: suspend () -> T): T =
        mutex.withLock {
            // What runs here, such as a reset, can undo what was staged.
            lastCommittedTargetKey = null
            block()
        }

    /** Waits for the lock, then checks; cancelling the caller ends the wait and the requests. */
    suspend fun checkForUpdate(options: NativeCheckRequest): HotUpdaterUpdate? = mutex.withLock { check(options) }?.update

    /**
     * `HotUpdaterUpdate.updateBundle`: joins a staging of the same target,
     * returns at once when this update already staged, or stages once the
     * lock is free.
     */
    private suspend fun updateBundle(
        update: HotUpdaterUpdate,
        selection: SelectedUpdate,
        onProgress: ((Double) -> Unit)?,
    ): Boolean {
        val running = synchronized(inFlightLock) { inFlight?.takeIf { it.update?.targetKey == update.targetKey } }
        val staging =
            running ?: run {
                // A reset or a newer catalog can undo a staging; it counts only while current.
                if (selection.staged && state.isReleaseSelectionCurrent(selection.guard)) return true
                mutex.lock()
                // A staging of the same target may have committed while this call
                // waited, or before it was made; it counts while the selection is current.
                if (selection.staged || lastCommittedTargetKey == update.targetKey) {
                    val current =
                        try {
                            state.isReleaseSelectionCurrent(selection.guard)
                        } finally {
                            mutex.unlock()
                        }
                    if (!current) throw StaleReleaseCatalogException()
                    selection.staged = true
                    return true
                }
                try {
                    startStaging(update, selection, onProgress)
                } catch (error: Throwable) {
                    mutex.unlock()
                    throw error
                }
            }
        val result = staging.result!!
        // A new staging registered the listener before it started.
        if (running != null) onProgress?.let(staging.progress::add)
        try {
            val committed = result.await().committed
            // A joined staging of the same target staged this update too.
            if (committed) selection.staged = true
            return committed
        } finally {
            onProgress?.let(staging.progress::remove)
        }
    }

    /**
     * Starts staging [update] in the process-wide scope, which takes over the
     * lock the caller holds and releases it when the staging ends. The staging
     * is registered before the caller's lock is handed over, and cleared
     * together with the lock's release.
     */
    private fun startStaging(
        update: HotUpdaterUpdate,
        selection: SelectedUpdate,
        onProgress: ((Double) -> Unit)?,
    ): Staging {
        val progress = ProgressFanout()
        // Before the staging starts, so its first reports reach the caller.
        onProgress?.let(progress::add)
        lateinit var staging: Staging
        val result =
            stagingScope.async(start = CoroutineStart.LAZY) {
                try {
                    val committed = install(selection, progress)
                    if (committed) {
                        selection.staged = true
                        lastCommittedTargetKey = update.targetKey
                        progress.report(1.0)
                    }
                    StagingOutcome(committed)
                } catch (error: Exception) {
                    Log.w(TAG, "Update failed", error)
                    throw error
                } finally {
                    synchronized(inFlightLock) {
                        if (inFlight === staging) inFlight = null
                        mutex.unlock()
                    }
                }
            }
        staging = Staging(update, result, progress)
        synchronized(inFlightLock) { inFlight = staging }
        result.start()
        return staging
    }

    private fun validateOptions(options: NativeCheckRequest) {
        requireValidBaseURL(options.baseURL)
        // OkHttp takes a call timeout of at most Int.MAX_VALUE milliseconds.
        require(options.requestTimeoutMillis in 1..Int.MAX_VALUE.toLong()) {
            "requestTimeoutMillis must be between 1 and ${Int.MAX_VALUE}"
        }
    }

    private suspend fun check(options: NativeCheckRequest): CheckedUpdate? {
        val currentAppVersion = state.getAppVersion()
        val currentBundleId = resolveBundleId(state.getBundleId())
        val minimumReleaseId = state.getMinBundleId()
        val defaultChannel = state.getDefaultChannel()
        val runtimeChannel = state.getChannel()
        val isSwitched = runtimeChannel != defaultChannel
        val currentChannel = if (isSwitched) runtimeChannel else defaultChannel
        val explicitChannel = options.channel?.takeIf { it.isNotEmpty() }
        val targetChannel = explicitChannel ?: currentChannel
        // A check that cannot start, with an invalid cohort, no app version, or
        // another channel while the runtime channel is switched, throws without
        // onUpdateError: checkForUpdate.ts reports these only to onError.
        val cohort = normalizeAndValidateCohort(state.getCohort())

        if (currentAppVersion.isNullOrEmpty()) {
            throw IllegalStateException("Failed to get app version")
        }

        if (isSwitched && explicitChannel != null && explicitChannel != currentChannel) {
            throw IllegalStateException(
                "Runtime channel is already switched to \"$currentChannel\". " +
                    "Call hotUpdater.resetChannel() before checking \"$explicitChannel\".",
            )
        }

        val input =
            CheckInput(
                options = options,
                baseURL = options.baseURL.trimEnd('/'),
                currentAppVersion = currentAppVersion,
                currentBundleId = currentBundleId,
                minimumReleaseId = minimumReleaseId,
                currentChannel = currentChannel,
                isSwitched = isSwitched,
                targetChannel = targetChannel,
                explicitChannel = explicitChannel,
                cohort = cohort,
                fingerprintHash = state.getFingerprintHash(),
            )
        requestChannel = targetChannel
        requestCohort = cohort

        val checked =
            try {
                // Invalid options fail the check as a failed request does in
                // JavaScript, so they are reported too.
                validateOptions(options)
                checkReleaseCatalog(input)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                state.appendUpdateLog(
                    UpdateLogEvent(
                        type = UpdateLogEvent.CHECK,
                        outcome = UpdateLogEvent.FAILED,
                        bundleId = currentBundleId,
                        channel = targetChannel,
                        error = UpdateLogEvent.errorOf(error),
                    ),
                )
                reportUpdateError(
                    error,
                    classifyUpdateError(error, UpdateFailureStage.CHECK, UpdateFailureResource.CATALOG),
                    ErrorScope(
                        bundleId = currentBundleId,
                        channel = targetChannel,
                        updateStrategy = options.updateStrategy,
                    ),
                )
                throw error
            }
        if (checked == null) {
            // The app keeps its bundle, as checkForUpdate.ts reports it.
            val releaseId = runningReleaseId(currentBundleId, currentChannel)
            queueUnchanged(currentChannel, currentBundleId, releaseId, previousReleaseId = releaseId)
        }
        return checked
    }

    private fun queueHttpResponse(
        request: UpdateCheckRequest,
        response: UpdateCheckResponse,
    ) {
        val path =
            try {
                URL(request.url).path.ifEmpty { "/" }
            } catch (_: MalformedURLException) {
                "/"
            }
        val body = response.body
        events.add(
            "onHttpResponse",
            JSONObject().apply {
                put("resource", request.resource)
                requestChannel?.let { put("channel", it) }
                put("path", path)
                put("status", response.status)
                putNullable("body", body?.take(HTTP_RESPONSE_BODY_LIMIT))
                put("bodyTruncated", body != null && body.length > HTTP_RESPONSE_BODY_LIMIT)
            },
        )
    }

    private fun queueUnchanged(
        channel: String,
        bundleId: String,
        releaseId: String?,
        previousReleaseId: String?,
    ) {
        state.appendUpdateLog(
            UpdateLogEvent(
                type = UpdateLogEvent.CHECK,
                outcome = UpdateLogEvent.UP_TO_DATE,
                bundleId = bundleId,
                releaseId = releaseId,
                channel = channel,
            ),
        )
        events.add(
            "onUpdateCheck",
            JSONObject().apply {
                put("status", "UNCHANGED")
                put("channel", channel)
                put("bundleId", bundleId)
                putNullable("releaseId", releaseId)
                putNullable("previousReleaseId", previousReleaseId)
            },
        )
    }

    private class CheckInput(
        val options: NativeCheckRequest,
        val baseURL: String,
        val currentAppVersion: String,
        val currentBundleId: String,
        val minimumReleaseId: String,
        val currentChannel: String,
        val isSwitched: Boolean,
        val targetChannel: String,
        val explicitChannel: String?,
        val cohort: String,
        val fingerprintHash: String?,
    )

    private class ErrorScope(
        val bundleId: String,
        val channel: String,
        val updateStrategy: HotUpdaterUpdateStrategy,
        val targetBundleId: String? = null,
        val targetReleaseId: String? = null,
    )

    private class CheckedUpdate(
        val update: HotUpdaterUpdate,
        /** What staging the update needs; none for leaving a switched channel. */
        val selection: SelectedUpdate?,
    )

    /** What staging a selected update needs. */
    private class SelectedUpdate(
        val input: CheckInput,
        val desiredBundleId: String,
        val desiredReleaseId: String?,
        val receipt: PersistedSelection,
        val guard: ReleaseSelectionGuard,
        val transitionKind: String,
        val fromReleaseId: String?,
        /** The Release the active selection had before this update. */
        val activeReleaseId: String?,
        val errorScope: ErrorScope,
    ) {
        /** This update already staged or committed; calling `updateBundle` again returns at once. */
        @Volatile
        var staged = false
    }

    private suspend fun checkReleaseCatalog(input: CheckInput): CheckedUpdate? {
        val options = input.options
        val channelKey = ReleaseCatalogs.encodeChannelKey(input.targetChannel)
        val strategy = options.updateStrategy.releaseStrategy
        val canonicalAppVersion = ReleaseCatalogs.canonicalizeAppVersion(input.currentAppVersion)
        if (strategy == ReleaseStrategy.APP_VERSION && canonicalAppVersion == null) {
            throw IllegalStateException("Failed to canonicalize app version")
        }
        val fingerprintHash = input.fingerprintHash
        if (strategy == ReleaseStrategy.FINGERPRINT && fingerprintHash.isNullOrEmpty()) {
            throw IllegalStateException("Fingerprint hash is required")
        }
        val strategyValue = if (strategy == ReleaseStrategy.APP_VERSION) canonicalAppVersion!! else fingerprintHash!!
        val expectedScope =
            if (strategy == ReleaseStrategy.APP_VERSION) {
                ReleaseCatalogScope.AppVersion(platform = PLATFORM, channelKey = channelKey)
            } else {
                ReleaseCatalogScope.Fingerprint(platform = PLATFORM, channelKey = channelKey, fingerprintHash = strategyValue)
            }
        val strategyPath = if (strategy == ReleaseStrategy.APP_VERSION) "app-version" else "fingerprint"
        val answer =
            catalogClient.fetchReleaseCatalog(
                baseURL = input.baseURL,
                url =
                    "${input.baseURL}/release-catalogs/$strategyPath/$PLATFORM/$channelKey/" +
                        encodeURIComponent(strategyValue),
                expectedScope = expectedScope,
                requestHeaders = options.requestHeaders,
                requestTimeoutMillis = options.requestTimeoutMillis,
            )
        if (answer != null && !ReleaseCatalogs.hasExpectedScope(answer.scopeKey, expectedScope)) {
            throw InvalidUpdateResponseException("Received an invalid Release catalog")
        }
        // The server answered with a valid catalog, or with none yet.
        state.recordRecoveryRequest(options)
        // The server says this scope has no catalog yet: no update, not a failure.
        val catalog = answer ?: return null
        val catalogId = catalog.catalogId
        val scopeKey = catalog.scopeKey

        val crashedBundleIds = state.getCrashHistory()
        val activeState = state.getActiveUpdateState()
        val active = activeState.activeSelection
        val explicitScopeSwitch = input.explicitChannel != null && input.explicitChannel != input.currentChannel
        val activeInTargetScope = active?.takeIf { it.catalogId == catalogId && it.scopeKey == scopeKey }
        val hasAuthenticatedActive =
            active != null && active.catalogId != null && active.scopeKey != null && active.generation != null
        if (hasAuthenticatedActive && activeInTargetScope == null && !explicitScopeSwitch) {
            throw IllegalStateException("Release transition rejected: UNSOLICITED_SCOPE")
        }
        val selectorCurrentBundleId =
            if (activeInTargetScope != null || (!hasAuthenticatedActive && !explicitScopeSwitch)) {
                input.currentBundleId
            } else {
                input.minimumReleaseId
            }
        val selectionContextHash =
            ReleaseSelector.createSelectionContextHash(
                ReleaseSelectionContextInput(
                    activeBundleId = selectorCurrentBundleId,
                    activeReleaseId = activeInTargetScope?.releaseId,
                    cohort = input.cohort,
                    minimumReleaseId = input.minimumReleaseId,
                    strategy = strategy,
                    strategyValue = strategyValue,
                    crashedBundleIds = crashedBundleIds,
                ),
            )
        val guard =
            ReleaseSelectionGuard(
                catalogId = catalogId,
                scopeKey = scopeKey,
                generation = catalog.generation,
                catalogHash = catalog.catalogHash,
                channel = input.targetChannel,
                selectionContextHash = selectionContextHash,
            )
        if (!state.acceptReleaseCatalog(guard)) {
            throw InvalidUpdateResponseException("Rejected a stale or inconsistent Release catalog")
        }
        // The switched channel holds nothing for this build any more, as a
        // deleted channel does: the server answers its scope with an accepted
        // catalog without releases. A scope without a catalog proves nothing,
        // since a cache can still answer that for a channel deployed seconds ago.
        if (
            input.isSwitched &&
            input.targetChannel == input.currentChannel &&
            catalog.releases.isEmpty() &&
            catalog.rollbackReleases.isEmpty()
        ) {
            return leaveSwitchedChannel(input, guard)
        }
        val stableInTargetScope =
            activeState.stableSelection?.takeIf { it.catalogId == catalogId && it.scopeKey == scopeKey }
        val desired =
            ReleaseSelector.selectDesiredRelease(
                catalog,
                ReleaseSelectionInput(
                    builtInBundleId = input.minimumReleaseId,
                    currentBundleId = selectorCurrentBundleId,
                    activeReleaseId = activeInTargetScope?.releaseId,
                    // A staged update is active but not running yet; force decisions count
                    // from the Release the app runs.
                    runningReleaseId =
                        RunningReleaseId.Explicit(
                            listOf(activeInTargetScope, stableInTargetScope)
                                .firstOrNull { it?.bundleId == selectorCurrentBundleId }
                                ?.releaseId,
                        ),
                    minimumReleaseId = input.minimumReleaseId,
                    cohort = input.cohort,
                    crashedBundleIds = crashedBundleIds,
                ),
            ) ?: return null

        if (
            desired.kind == SelectionKind.BUILTIN &&
            input.currentBundleId == input.minimumReleaseId &&
            (active == null || active.kind == SelectionKind.BUILTIN.name)
        ) {
            return null
        }

        val receipt =
            PersistedSelection(
                kind = desired.kind.name,
                releaseId = desired.releaseId,
                bundleId = desired.bundleId,
                catalogId = catalogId,
                scopeKey = scopeKey,
                generation = catalog.generation,
                catalogHash = catalog.catalogHash,
                channel = input.targetChannel,
                selectionContextHash = selectionContextHash,
            )
        if (active == receipt) return null

        val authorization = ReleaseSelector.authorizeReleaseTransition(active, receipt, explicitScopeSwitch)
        if (!authorization.authorized) {
            if (authorization == ReleaseTransitionReason.EMPTY_TARGET_SCOPE) return null
            throw IllegalStateException("Release transition rejected: ${authorization.name}")
        }

        val release = desired.release
        val transitionKind =
            when {
                desired.kind == SelectionKind.BUILTIN -> "USE_BUILTIN"
                active?.bundleId == desired.bundleId -> "ADOPT_RELEASE"
                else -> "INSTALL"
            }
        val fromReleaseId =
            listOf(active, activeState.stableSelection)
                .firstOrNull { it != null && it.bundleId == input.currentBundleId }
                ?.releaseId
        val selection =
            SelectedUpdate(
                input = input,
                desiredBundleId = desired.bundleId,
                desiredReleaseId = desired.releaseId,
                receipt = receipt,
                guard = guard,
                transitionKind = transitionKind,
                fromReleaseId = fromReleaseId,
                activeReleaseId = active?.releaseId,
                errorScope =
                    ErrorScope(
                        bundleId = input.currentBundleId,
                        channel = input.targetChannel,
                        updateStrategy = options.updateStrategy,
                        targetBundleId = desired.bundleId,
                        targetReleaseId = desired.releaseId,
                    ),
            )

        // Adopting the bundle the app already runs needs no reload; adopting a
        // staged one does when the selector forces it.
        val shouldForceUpdate =
            if (desired.bundleId == input.currentBundleId) false else desired.shouldForceUpdate
        state.appendUpdateLog(
            UpdateLogEvent(
                type = UpdateLogEvent.CHECK,
                outcome =
                    if (desired.status == DesiredReleaseStatus.ROLLBACK) {
                        UpdateLogEvent.ROLLBACK_AVAILABLE
                    } else {
                        UpdateLogEvent.UPDATE_AVAILABLE
                    },
                bundleId = desired.bundleId,
                fromBundleId = input.currentBundleId,
                releaseId = desired.releaseId,
                channel = input.targetChannel,
            ),
        )
        events.add(
            "onUpdateCheck",
            JSONObject().apply {
                put("status", "UPDATE_AVAILABLE")
                put("channel", input.targetChannel)
                put("fromBundleId", input.currentBundleId)
                putNullable("fromReleaseId", fromReleaseId)
                put("toBundleId", desired.bundleId)
                putNullable("toReleaseId", desired.releaseId)
                put("transitionKind", transitionKind)
                put("updateStatus", desired.status.name)
                put("shouldForceUpdate", shouldForceUpdate)
                put("updateStrategy", options.updateStrategy.value)
            },
        )

        lateinit var update: HotUpdaterUpdate
        update =
            HotUpdaterUpdate(
                id = desired.releaseId ?: desired.bundleId,
                releaseId = desired.releaseId,
                status =
                    if (desired.status == DesiredReleaseStatus.ROLLBACK) {
                        HotUpdaterUpdateStatus.ROLLBACK
                    } else {
                        HotUpdaterUpdateStatus.UPDATE
                    },
                shouldForceUpdate = shouldForceUpdate,
                message = release?.message,
                rolloutCohortCount = release?.rolloutCohortCount ?: ReleaseSelector.DEFAULT_ROLLOUT_COHORT_COUNT,
                targetCohorts = release?.targetCohorts?.toList() ?: emptyList(),
                transitionKind = transitionKind,
                runsCurrentBundle = desired.bundleId == input.currentBundleId,
                // JSON, so no field can spell another, such as a channel with a colon.
                targetKey =
                    JSONArray()
                        .put(desired.kind.name)
                        .put(desired.bundleId)
                        .put(desired.releaseId ?: JSONObject.NULL)
                        .put(input.targetChannel)
                        .put(guard.catalogId)
                        .put(guard.generation)
                        .put(guard.catalogHash)
                        .put(guard.selectionContextHash)
                        .toString(),
                install = { onProgress -> updateBundle(update, selection, onProgress) },
            )
        return CheckedUpdate(update, selection)
    }

    /**
     * Leaves a switched channel that holds nothing for this build, such as a
     * deleted one, as checkForUpdate.ts does: a rollback to the built-in
     * bundle whose staging also clears the runtime channel, so the next check
     * reads the build's default channel. The check itself resets nothing,
     * since the reset removes the running bundle's files.
     */
    private fun leaveSwitchedChannel(
        input: CheckInput,
        guard: ReleaseSelectionGuard,
    ): CheckedUpdate {
        val options = input.options
        val channel = input.currentChannel
        val runsBuiltIn = input.currentBundleId == input.minimumReleaseId
        val errorScope =
            ErrorScope(
                bundleId = input.currentBundleId,
                channel = channel,
                updateStrategy = options.updateStrategy,
                targetBundleId = input.minimumReleaseId,
            )
        state.appendUpdateLog(
            UpdateLogEvent(
                type = UpdateLogEvent.CHECK,
                outcome = UpdateLogEvent.ROLLBACK_AVAILABLE,
                bundleId = input.minimumReleaseId,
                fromBundleId = input.currentBundleId,
                channel = channel,
            ),
        )
        events.add(
            "onUpdateCheck",
            JSONObject().apply {
                put("status", "UPDATE_AVAILABLE")
                put("channel", channel)
                put("fromBundleId", input.currentBundleId)
                putNullable("fromReleaseId", runningReleaseId(input.currentBundleId, channel))
                put("toBundleId", input.minimumReleaseId)
                put("toReleaseId", JSONObject.NULL)
                put("transitionKind", "USE_BUILTIN")
                put("updateStatus", DesiredReleaseStatus.ROLLBACK.name)
                put("shouldForceUpdate", !runsBuiltIn)
                put("updateStrategy", options.updateStrategy.value)
            },
        )
        // With the catalog's freshness guard, as ordinary selections, so a
        // leave from an older catalog never counts as a current one.
        val targetKey =
            JSONArray()
                .put("LEAVE_CHANNEL")
                .put(channel)
                .put(input.minimumReleaseId)
                .put(guard.catalogId)
                .put(guard.generation)
                .put(guard.catalogHash)
                .put(guard.selectionContextHash)
                .toString()
        val update =
            HotUpdaterUpdate(
                id = input.minimumReleaseId,
                releaseId = null,
                status = HotUpdaterUpdateStatus.ROLLBACK,
                shouldForceUpdate = !runsBuiltIn,
                message = null,
                rolloutCohortCount = ReleaseSelector.DEFAULT_ROLLOUT_COHORT_COUNT,
                targetCohorts = emptyList(),
                transitionKind = "USE_BUILTIN",
                runsCurrentBundle = runsBuiltIn,
                targetKey = targetKey,
                install = { _ ->
                    try {
                        // Once no check or staging runs, as a reset must; only a real
                        // reset undoes what was staged.
                        mutex.withLock {
                            // This leave, from this or another result of the same catalog,
                            // already happened: calling it again changes nothing, not even
                            // what was staged since.
                            if (lastLeftTargetKey == targetKey && state.getChannel() == state.getDefaultChannel()) {
                                return@withLock true
                            }
                            // A device that left or changed the channel meanwhile keeps it;
                            // native checks the catalog again in the same step as the reset,
                            // so a newer one accepted meanwhile keeps it too.
                            if (state.getChannel() != channel || !state.resetChannelIfSelectionCurrent(guard)) {
                                throw StaleReleaseCatalogException()
                            }
                            lastCommittedTargetKey = null
                            lastLeftTargetKey = targetKey
                            events.remove("onBundleDownloaded")
                            true
                        }
                    } catch (error: CancellationException) {
                        throw error
                    } catch (error: Exception) {
                        reportUpdateError(
                            error,
                            classifyUpdateError(error, UpdateFailureStage.DOWNLOAD, UpdateFailureResource.ARTIFACT),
                            errorScope,
                        )
                        throw error
                    }
                },
            )
        return CheckedUpdate(update, selection = null)
    }

    /**
     * Commits or stages [selection] as `updateBundleForSelection` in
     * checkForUpdate.ts does, queueing `onUpdateError` for a classified failure.
     */
    private suspend fun install(
        selection: SelectedUpdate,
        progress: ProgressFanout,
    ): Boolean {
        try {
            return installSelection(selection, progress)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            val failure =
                if (error is NativeCall.Failure) {
                    (error.cause as? HotUpdaterException)?.failure
                } else {
                    classifyUpdateError(error, UpdateFailureStage.DOWNLOAD, UpdateFailureResource.ARTIFACT)
                }
            val cause = (error as? NativeCall.Failure)?.cause ?: error
            // A failure from native staging is already in the update log.
            if (error !is NativeCall.Failure) {
                state.appendUpdateLog(
                    UpdateLogEvent(
                        type = UpdateLogEvent.DOWNLOAD,
                        outcome = UpdateLogEvent.FAILED,
                        bundleId = selection.desiredBundleId,
                        fromBundleId = selection.input.currentBundleId,
                        releaseId = selection.receipt.releaseId,
                        channel = selection.receipt.channel,
                        error = UpdateLogEvent.errorOf(cause),
                    ),
                )
            }
            reportUpdateError(cause, failure, selection.errorScope)
            throw cause
        }
    }

    private suspend fun installSelection(
        selection: SelectedUpdate,
        progress: ProgressFanout,
    ): Boolean {
        val input = selection.input
        val options = input.options
        requestChannel = input.targetChannel
        requestCohort = input.cohort
        if (!state.isReleaseSelectionCurrent(selection.guard)) {
            throw StaleReleaseCatalogException()
        }

        if (selection.transitionKind != "INSTALL") {
            val committed = NativeCall.run { state.commitReleaseSelection(selection.receipt) }
            if (committed && selection.transitionKind == "USE_BUILTIN") {
                // The built-in bundle replaced every staged one: their downloads are void.
                events.remove("onBundleDownloaded")
            }
            // Only the running bundle is unchanged: adopting a staged bundle's
            // newer Release leaves it to report itself when it launches.
            if (
                committed &&
                selection.transitionKind == "ADOPT_RELEASE" &&
                selection.desiredBundleId == selection.input.currentBundleId
            ) {
                // The running bundle is now selected as a newer Release.
                queueUnchanged(
                    channel = selection.receipt.channel,
                    bundleId = selection.receipt.bundleId,
                    releaseId = selection.receipt.releaseId,
                    previousReleaseId = selection.activeReleaseId,
                )
            }
            return committed
        }

        val artifact =
            catalogClient.resolveArtifact(
                baseURL = input.baseURL,
                currentBundleId = input.currentBundleId,
                targetBundleId = selection.desiredBundleId,
                requestHeaders = options.requestHeaders,
                requestTimeoutMillis = options.requestTimeoutMillis,
            )
        if (!state.isReleaseSelectionCurrent(selection.guard)) {
            throw StaleReleaseCatalogException()
        }
        val staged =
            NativeCall.run {
                state.updateBundle(
                    StageBundleRequest(
                        bundleId = selection.desiredBundleId,
                        channel = input.targetChannel,
                        manifestUrl = artifact.manifestUrl,
                        manifestFileHash = artifact.manifestFileHash,
                        assets = artifact.assets,
                        archiveUrl = artifact.archiveUrl,
                        selection = selection.receipt,
                        filesUrl = artifact.filesUrl,
                        requestHeaders = options.requestHeaders,
                        requestTimeoutMillis = options.requestTimeoutMillis,
                        onFilesResponse =
                            artifact.filesUrl?.let { filesUrl ->
                                { status, body ->
                                    queueHttpResponse(
                                        UpdateCheckRequest(filesUrl, emptyMap(), options.requestTimeoutMillis, "artifact"),
                                        UpdateCheckResponse(status, "", emptyMap(), body),
                                    )
                                }
                            },
                    ),
                    progress::report,
                )
            }
        if (selection.desiredBundleId != input.currentBundleId) {
            events.add(
                "onBundleDownloaded",
                JSONObject().apply {
                    put("channel", input.targetChannel)
                    put("fromBundleId", input.currentBundleId)
                    putNullable("fromReleaseId", selection.fromReleaseId)
                    put("toBundleId", selection.desiredBundleId)
                    putNullable("toReleaseId", selection.desiredReleaseId)
                    put("updateStrategy", options.updateStrategy.value)
                    put("delivery", staged.delivery.value)
                    put("patchFallback", staged.patchFallback)
                },
            )
        }
        return true
    }

    /**
     * Wraps what the native `updateBundle` and `commitReleaseSelection` throw.
     * JavaScript classifies a native rejection only by the classification
     * native attached, so anything else is not an update failure.
     */
    private object NativeCall {
        class Failure(
            override val cause: Exception,
        ) : Exception(cause)

        suspend fun <T> run(block: suspend () -> T): T =
            try {
                block()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                throw Failure(error)
            }
    }

    /**
     * Where and why an update failed, or null when the error is not an update
     * failure, as `classifyUpdateError` in updateError.ts reads an error the
     * SDK raised itself.
     */
    private fun classifyUpdateError(
        error: Exception,
        stage: UpdateFailureStage,
        resource: UpdateFailureResource,
    ): UpdateFailure? =
        when (error) {
            is HotUpdaterException -> {
                error.failure
            }

            is StaleReleaseCatalogException, is StaleReleaseSelectionException -> {
                null
            }

            is UpdateHttpException -> {
                UpdateFailure(stage, UpdateFailureReason.HTTP, httpStatus = error.status, resource = resource)
            }

            is InvalidUpdateResponseException, is JSONException -> {
                UpdateFailure(stage, UpdateFailureReason.INVALID_RESPONSE, resource = resource)
            }

            is IOException -> {
                UpdateFailure(
                    stage,
                    UpdateFailureReason.NETWORK,
                    resource = resource,
                    transport = UpdateFailure.transportOf(error, state::isOffline),
                )
            }

            else -> {
                UpdateFailure(stage, UpdateFailureReason.UNKNOWN, resource = resource)
            }
        }

    /** [cohort] tags the event when it happened under another cohort than the running check's. */
    private fun reportUpdateError(
        error: Exception,
        failure: UpdateFailure?,
        scope: ErrorScope,
        cohort: String? = null,
    ) {
        if (failure == null) return
        events.add(
            "onUpdateError",
            JSONObject().apply {
                failure.toUserInfo().forEach { (key, value) -> put(key, value) }
                put("channel", scope.channel)
                put("bundleId", scope.bundleId)
                putNullable("releaseId", runningReleaseId(scope.bundleId, state.getChannel()))
                put("updateStrategy", scope.updateStrategy.value)
                scope.targetBundleId?.let { put("targetBundleId", it) }
                scope.targetReleaseId?.let { put("targetReleaseId", it) }
                put("message", error.message ?: error.javaClass.name)
            },
            cohort?.let { NativeUpdateEventQueue.buildOf(state.getAppVersion(), state.getMinBundleId(), it) },
        )
    }

    /** The Release the running bundle is selected as on [channel], as `getRunningReleaseId` in appReady.ts. */
    private fun runningReleaseId(
        bundleId: String,
        channel: String,
    ): String? {
        val activeState = state.getActiveUpdateState()
        return listOf(activeState.activeSelection, activeState.stableSelection)
            .firstOrNull { it != null && it.bundleId == bundleId && it.channel == channel }
            ?.releaseId
    }

    private fun resolveBundleId(bundleId: String?): String =
        if (bundleId.isNullOrEmpty() || bundleId == NIL_UUID) state.getMinBundleId() else bundleId

    private fun normalizeAndValidateCohort(cohort: String): String {
        val normalized = ReleaseSelector.normalizeCohortValue(cohort)
        val isNumeric = normalized.isNotEmpty() && normalized.all { it in '0'..'9' } && normalized.toIntOrNull() in 1..1000
        require(isNumeric || ReleaseSelector.isCustomCohort(normalized)) { INVALID_COHORT_MESSAGE }
        return normalized
    }
}

internal fun JSONObject.putNullable(
    name: String,
    value: Any?,
): JSONObject = put(name, value ?: JSONObject.NULL)

/** `encodeURIComponent`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` is percent-encoded as UTF-8. */
internal fun encodeURIComponent(value: String): String =
    buildString {
        for (byte in value.toByteArray(Charsets.UTF_8)) {
            val code = byte.toInt() and 0xff
            val char = code.toChar()
            if (
                char in 'A'..'Z' ||
                char in 'a'..'z' ||
                char in '0'..'9' ||
                char in "-_.!~*'()"
            ) {
                append(char)
            } else {
                append('%')
                append("0123456789ABCDEF"[code shr 4])
                append("0123456789ABCDEF"[code and 0x0f])
            }
        }
    }
