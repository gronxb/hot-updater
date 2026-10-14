package com.hotupdater

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.io.InterruptedIOException
import java.net.MalformedURLException
import java.net.URL
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

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
)

/** The native state the check reads and writes, the same the TurboModule exposes. */
internal interface UpdateCheckState {
    fun getAppVersion(): String?

    /** The running bundle, or before React Native starts the one its launch would pick; null is the built-in bundle. */
    fun getBundleId(): String?

    /** Whether React Native already read the bundle in this process, which fixes this launch's bundle. */
    fun hasLaunchedBundle(): Boolean

    fun getMinBundleId(): String

    fun getDefaultChannel(): String

    fun getChannel(): String

    fun getCohort(): String

    fun getFingerprintHash(): String?

    fun getCrashHistory(): List<String>

    fun getActiveUpdateState(): ActiveSelections

    fun acceptReleaseCatalog(guard: ReleaseSelectionGuard): Boolean

    fun isReleaseSelectionCurrent(guard: ReleaseSelectionGuard): Boolean

    suspend fun commitReleaseSelection(selection: PersistedSelection): Boolean

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

internal class NativeUpdateChecker(
    private val state: UpdateCheckState,
    private val transport: UpdateCheckTransport,
    private val stagingScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    companion object {
        private const val TAG = "HotUpdaterCheck"
        private const val PLATFORM = "android"
        private const val NIL_UUID = "00000000-0000-0000-0000-000000000000"
        private const val LOCK_POLL_MILLIS = 20L

        /** The longest response body queued: the queue lives in the key-value store. */
        private const val HTTP_RESPONSE_BODY_LIMIT = 4_096
        private const val INVALID_COHORT_MESSAGE =
            "Invalid cohort. Use 1-1000 or a lowercase slug without spaces, up to ${ReleaseSelector.MAX_COHORT_LENGTH} characters."
        private val HTTP_URL = Regex("^https?://.+", RegexOption.IGNORE_CASE)
    }

    private class StagingOutcome(
        val committed: Boolean,
        /** Staged before React Native read the bundle in this process. */
        val beforeLaunch: Boolean,
    )

    private class Staging(
        val update: HotUpdaterUpdate?,
        val result: Deferred<StagingOutcome>?,
        val progress: ProgressFanout,
    )

    /** A placeholder: the lock is held by a check that has not started a staging yet. */
    private val lockHeldByCheck = Staging(null, null, ProgressFanout())

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

    /** Waits for the lock and the requests without a deadline beyond each request's timeout. */
    suspend fun checkForUpdate(options: HotUpdaterCheckOptions): HotUpdaterUpdate? =
        mutex.withLock { check(options, deadline = null) }?.update

    /**
     * Checks for an update and starts it within one deadline of [timeoutMillis]
     * covering the lock wait, the catalog request, and the wait for a required
     * update.
     * The deadline and cancellation end the wait, never the staging. Never
     * throws except to cancel.
     */
    suspend fun prepare(
        options: HotUpdaterCheckOptions,
        timeoutMillis: Long,
        onProgress: ((Double) -> Unit)?,
    ): HotUpdaterPrepareResult {
        if (timeoutMillis <= 0) {
            return HotUpdaterPrepareResult.Failed(IllegalArgumentException("timeoutMillis must be positive"), null)
        }
        // Saturates, so a timeout such as Long.MAX_VALUE never wraps into the
        // past; differences of nanoTime stay correct when the sum wraps.
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis)
        return try {
            while (true) {
                // Read together with the lock, so a staging is either joined or
                // finished and its lock released: never started twice.
                val running =
                    synchronized(inFlightLock) {
                        inFlight ?: if (mutex.tryLock()) null else lockHeldByCheck
                    }
                if (running == null) break
                // A staging from other options is waited for, then this request is checked.
                if (running !== lockHeldByCheck && running.update?.requestKey == requestKey(options, currentCohort())) {
                    val joined = awaitStaging(running, deadline, onProgress)
                    // The staging may have failed on its own caller's shorter
                    // timeout; this call checks again within its own deadline.
                    if (joined is HotUpdaterPrepareResult.Failed && remainingMillis(deadline) > 0) continue
                    return joined
                }
                val remaining = remainingMillis(deadline)
                if (remaining <= 0) {
                    reportLockTimeout(options)
                    return HotUpdaterPrepareResult.Failed(
                        TimeoutException("Timed out waiting for another update check"),
                        null,
                    )
                }
                delay(minOf(LOCK_POLL_MILLIS, remaining))
            }
            var handedOff = false
            try {
                val checked =
                    try {
                        withTimeout(remainingMillis(deadline).coerceAtLeast(1)) { check(options, deadline) }
                    } catch (error: TimeoutCancellationException) {
                        return HotUpdaterPrepareResult.Failed(TimeoutException("Timed out checking for an update"), null)
                    } ?: return HotUpdaterPrepareResult.UpToDate
                val update = checked.update
                // The deadline ends the wait, not the staging: its requests
                // keep their own timeouts after prepare returns.
                val staging = startStaging(update, checked.selection, artifactDeadline = null)
                handedOff = true
                awaitStaging(staging, deadline, onProgress)
            } finally {
                if (!handedOff) mutex.unlock()
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            Log.w(TAG, "Update check failed", error)
            HotUpdaterPrepareResult.Failed(error, null)
        }
    }

    /**
     * What a check reads: the server, the strategy, the channel it asks for,
     * the cohort it selects for, and the headers, which can name the
     * credentials or tenant.
     */
    private fun requestKey(
        options: HotUpdaterCheckOptions,
        cohort: String,
    ): String =
        // JSON, so no field can spell another, such as a channel with a newline.
        JSONArray()
            .put(options.baseURL.trimEnd('/'))
            .put(options.updateStrategy.value)
            .put(options.channel?.takeIf { it.isNotEmpty() }.orEmpty())
            .put(cohort)
            .put(
                JSONArray().apply {
                    effectiveHeaders(options.requestHeaders)
                        .entries
                        .sortedBy { it.key }
                        .forEach { (name, value) -> put(JSONArray().put(name).put(value)) }
                },
            ).toString()

    private fun currentCohort(): String = ReleaseSelector.normalizeCohortValue(state.getCohort())

    /**
     * Queues a prepare that its deadline ended while another check or staging
     * held the lock, as the check it never ran would report its own timeout.
     */
    private fun reportLockTimeout(options: HotUpdaterCheckOptions) {
        val timeout = InterruptedIOException("Timed out waiting for another update check")
        reportUpdateError(
            timeout,
            classifyUpdateError(timeout, UpdateFailureStage.CHECK, UpdateFailureResource.CATALOG),
            ErrorScope(
                bundleId = resolveBundleId(state.getBundleId()),
                channel = options.channel?.takeIf { it.isNotEmpty() } ?: state.getChannel(),
                updateStrategy = options.updateStrategy,
            ),
            // The waiting prepare's cohort, not the one the check holding the lock captured.
            cohort = currentCohort(),
        )
    }

    private fun remainingMillis(deadline: Long): Long = (deadline - System.nanoTime()) / 1_000_000

    private fun requestTimeout(
        options: HotUpdaterCheckOptions,
        deadline: Long?,
    ): Long =
        if (deadline == null) {
            options.requestTimeoutMillis
        } else {
            minOf(options.requestTimeoutMillis, remainingMillis(deadline).coerceAtLeast(1))
        }

    /** A required update is waited for until [deadline]; any other is not. */
    private suspend fun awaitStaging(
        staging: Staging,
        deadline: Long,
        onProgress: ((Double) -> Unit)?,
    ): HotUpdaterPrepareResult {
        val update = staging.update!!
        val result = staging.result!!
        // Recording the selection of the bundle this launch already runs, such
        // as on the first launch after an update, leaves nothing to apply.
        if (update.runsCurrentBundle) {
            return try {
                val outcome = withTimeoutOrNull(remainingMillis(deadline).coerceAtLeast(0)) { result.await() }
                if (outcome != null && !outcome.committed) {
                    HotUpdaterPrepareResult.Failed(StaleReleaseCatalogException(), update)
                } else {
                    HotUpdaterPrepareResult.UpToDate
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                HotUpdaterPrepareResult.Failed(error, update)
            }
        }
        if (!update.shouldForceUpdate) return HotUpdaterPrepareResult.Pending(update)
        onProgress?.let(staging.progress::add)
        return try {
            val outcome =
                withTimeoutOrNull(remainingMillis(deadline).coerceAtLeast(0)) { result.await() }
            when {
                outcome == null -> HotUpdaterPrepareResult.Pending(update)
                !outcome.committed -> HotUpdaterPrepareResult.Failed(StaleReleaseCatalogException(), update)
                outcome.beforeLaunch -> HotUpdaterPrepareResult.Ready(update)
                else -> HotUpdaterPrepareResult.Pending(update)
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            HotUpdaterPrepareResult.Failed(error, update)
        } finally {
            onProgress?.let(staging.progress::remove)
        }
    }

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
                    startStaging(update, selection, artifactDeadline = null)
                } catch (error: Throwable) {
                    mutex.unlock()
                    throw error
                }
            }
        val result = staging.result!!
        onProgress?.let(staging.progress::add)
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
        artifactDeadline: Long?,
    ): Staging {
        val progress = ProgressFanout()
        lateinit var staging: Staging
        val result =
            stagingScope.async(start = CoroutineStart.LAZY) {
                try {
                    val committed = install(selection, progress, artifactDeadline)
                    if (committed) {
                        selection.staged = true
                        lastCommittedTargetKey = update.targetKey
                        progress.report(1.0)
                    }
                    StagingOutcome(committed, beforeLaunch = !state.hasLaunchedBundle())
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

    private fun validateOptions(options: HotUpdaterCheckOptions) {
        val baseURL = options.baseURL
        val valid =
            HTTP_URL.matches(baseURL) &&
                try {
                    // java.net.URL parses a hostless "https:///api"; a request needs a host.
                    !URL(baseURL).host.isNullOrEmpty()
                } catch (_: MalformedURLException) {
                    false
                }
        require(valid) { "Invalid baseURL: $baseURL" }
        require(options.requestTimeoutMillis > 0) { "requestTimeoutMillis must be positive" }
    }

    private suspend fun check(
        options: HotUpdaterCheckOptions,
        deadline: Long?,
    ): CheckedUpdate? {
        val currentAppVersion = state.getAppVersion()
        val currentBundleId = resolveBundleId(state.getBundleId())
        val minimumReleaseId = state.getMinBundleId()
        val defaultChannel = state.getDefaultChannel()
        val runtimeChannel = state.getChannel()
        val isSwitched = runtimeChannel != defaultChannel
        val currentChannel = if (isSwitched) runtimeChannel else defaultChannel
        val explicitChannel = options.channel?.takeIf { it.isNotEmpty() }
        val targetChannel = explicitChannel ?: currentChannel
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
                checkReleaseCatalog(input, deadline)
            } catch (error: TimeoutCancellationException) {
                // prepare's deadline ended the check, not its caller: reported as a
                // request timeout, as iOS reports it.
                val timeout = InterruptedIOException("Timed out checking for an update")
                reportUpdateError(
                    timeout,
                    classifyUpdateError(timeout, UpdateFailureStage.CHECK, UpdateFailureResource.CATALOG),
                    ErrorScope(
                        bundleId = currentBundleId,
                        channel = targetChannel,
                        updateStrategy = options.updateStrategy,
                    ),
                )
                throw error
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
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
        val options: HotUpdaterCheckOptions,
        val baseURL: String,
        val currentAppVersion: String,
        val currentBundleId: String,
        val minimumReleaseId: String,
        val currentChannel: String,
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
        val selection: SelectedUpdate,
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

    private suspend fun checkReleaseCatalog(
        input: CheckInput,
        deadline: Long?,
    ): CheckedUpdate? {
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
        val catalog =
            catalogClient.fetchReleaseCatalog(
                baseURL = input.baseURL,
                url =
                    "${input.baseURL}/release-catalogs/$strategyPath/$PLATFORM/$channelKey/" +
                        encodeURIComponent(strategyValue),
                expectedScope = expectedScope,
                requestHeaders = options.requestHeaders,
                requestTimeoutMillis = requestTimeout(options, deadline),
            )
                // The server says this scope has no catalog yet: no update, not a failure.
                ?: return null
        if (!ReleaseCatalogs.hasExpectedScope(catalog.scopeKey, expectedScope)) {
            throw InvalidUpdateResponseException("Received an invalid Release catalog")
        }
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
                requestKey = requestKey(options, input.cohort),
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
     * Commits or stages [selection] as `updateBundleForSelection` in
     * checkForUpdate.ts does, queueing `onUpdateError` for a classified failure.
     */
    private suspend fun install(
        selection: SelectedUpdate,
        progress: ProgressFanout,
        artifactDeadline: Long?,
    ): Boolean {
        try {
            return installSelection(selection, progress, artifactDeadline)
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
            reportUpdateError(cause, failure, selection.errorScope)
            throw cause
        }
    }

    private suspend fun installSelection(
        selection: SelectedUpdate,
        progress: ProgressFanout,
        artifactDeadline: Long?,
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
            if (committed && selection.transitionKind == "ADOPT_RELEASE") {
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
                requestTimeoutMillis = requestTimeout(options, artifactDeadline),
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
