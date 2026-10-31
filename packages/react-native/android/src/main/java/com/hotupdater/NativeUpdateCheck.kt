package com.hotupdater

import android.content.Context

/** The native state behind the TurboModule, read and written through [HotUpdaterImpl]. */
internal class HotUpdaterImplUpdateCheckState(
    private val context: Context,
    private val impl: HotUpdaterImpl,
) : UpdateCheckState {
    private val cohortService by lazy { CohortService(context) }

    override fun getAppVersion(): String? = HotUpdaterImpl.getAppVersion(context)

    override fun getBundleId(): String? = impl.getBundleIdForUpdateCheck()

    override fun getMinBundleId(): String = HotUpdaterImpl.getMinBundleId()

    override fun getDefaultChannel(): String = impl.getDefaultChannel()

    override fun getChannel(): String = impl.getChannel()

    override fun getCohort(): String = cohortService.getCohort()

    override fun getFingerprintHash(): String? = impl.getFingerprintHash()

    override fun recordRecoveryRequest(request: NativeCheckRequest) = impl.recordRecoveryRequest(request)

    override fun appendUpdateLog(event: UpdateLogEvent) = impl.appendUpdateLog(event)

    override fun getCrashHistory(): List<String> = impl.getCrashHistory()

    override fun getActiveUpdateState(): ActiveSelections {
        val state = impl.getActiveUpdateState()
        return ActiveSelections(
            activeSelection = selectionOf(state["activeSelection"]),
            stableSelection = selectionOf(state["stableSelection"]),
        )
    }

    override fun acceptReleaseCatalog(guard: ReleaseSelectionGuard): Boolean =
        impl.acceptReleaseCatalog(
            catalogId = guard.catalogId,
            scopeKey = guard.scopeKey,
            generation = guard.generation,
            catalogHash = guard.catalogHash,
            channel = guard.channel,
            selectionContextHash = guard.selectionContextHash,
        )

    override fun isReleaseSelectionCurrent(guard: ReleaseSelectionGuard): Boolean =
        impl.isReleaseSelectionCurrent(
            catalogId = guard.catalogId,
            scopeKey = guard.scopeKey,
            generation = guard.generation,
            catalogHash = guard.catalogHash,
            channel = guard.channel,
            selectionContextHash = guard.selectionContextHash,
        )

    override suspend fun commitReleaseSelection(selection: PersistedSelection): Boolean = impl.commitReleaseSelection(selection)

    override suspend fun resetChannelIfSelectionCurrent(guard: ReleaseSelectionGuard): Boolean = impl.resetChannelIfSelectionCurrent(guard)

    override suspend fun updateBundle(
        request: StageBundleRequest,
        onProgress: (Double) -> Unit,
    ): UpdateBundleResult =
        impl.updateBundle(
            bundleId = request.bundleId,
            manifestUrl = request.manifestUrl,
            manifestFileHash = request.manifestFileHash,
            assets = request.assets,
            channel = request.channel,
            selection = request.selection,
            archiveUrl = request.archiveUrl,
            fileResolver =
                request.filesUrl?.let {
                    HttpArtifactFileResolver(it, request.requestHeaders, request.requestTimeoutMillis, request.onFilesResponse)
                },
            progressCallback = { onProgress(it.progress) },
        )

    override fun getReleaseCatalogCache(partition: String): String? = impl.getReleaseCatalogCache(partition)

    override fun setReleaseCatalogCache(
        partition: String,
        payload: String,
    ): Boolean = impl.setReleaseCatalogCache(partition, payload)

    override fun removeReleaseCatalogCache(partition: String): Boolean = impl.removeReleaseCatalogCache(partition)

    override fun getStorageItem(key: String): String? = impl.getStorageItem(key)

    override fun setStorageItem(
        key: String,
        value: String?,
    ) {
        impl.setStorageItem(key, value)
    }

    override fun isOffline(): Boolean = NetworkState.hasNoActiveNetwork(context)

    /** A selection of `getActiveUpdateState`, whose generation is a double for JavaScript. */
    private fun selectionOf(value: Any?): PersistedSelection? {
        val map = value as? Map<*, *> ?: return null
        return PersistedSelection(
            kind = map["kind"] as? String ?: return null,
            releaseId = map["releaseId"] as? String,
            bundleId = map["bundleId"] as? String ?: return null,
            catalogId = map["catalogId"] as? String,
            scopeKey = map["scopeKey"] as? String,
            generation = (map["generation"] as? Number)?.toLong(),
            catalogHash = map["catalogHash"] as? String,
            channel = map["channel"] as? String ?: "",
            selectionContextHash = map["selectionContextHash"] as? String,
        )
    }
}

/**
 * One native update checker per instance name, behind [HotUpdaterInstance]
 * and the TurboModule's `resetChannel`, which uses the checker of its
 * runtime's instance. Each checker serializes the work of its own name's state.
 */
internal object NativeUpdateCheck {
    private val checkers = HashMap<String, NativeUpdateChecker>()

    internal fun checker(
        context: Context,
        name: String,
        impl: () -> HotUpdaterImpl,
    ): NativeUpdateChecker =
        synchronized(checkers) {
            checkers.getOrPut(name) {
                NativeUpdateChecker(
                    HotUpdaterImplUpdateCheckState(context.applicationContext, impl()),
                    OkHttpUpdateCheckTransport(),
                )
            }
        }

    /**
     * The app process checks; Hot Updater's restart process only relaunches
     * it. A check there would settle the previous launch and consume the crash
     * marker before the relaunched app reads them.
     */
    private fun requireAppProcess(
        context: Context,
        call: String,
    ) {
        check(!HotUpdaterProcess.isRestartProcess(context)) {
            "$call runs in the app's process, not Hot Updater's restart process"
        }
    }

    suspend fun checkForUpdate(
        context: Context,
        name: String,
        impl: () -> HotUpdaterImpl,
        request: NativeCheckRequest,
    ): HotUpdaterUpdate? {
        requireAppProcess(context, "HotUpdaterInstance.checkForUpdate")
        return checker(context, name, impl).checkForUpdate(request)
    }

    /** Clears main's runtime channel once a check or staging running in this process finishes. */
    suspend fun resetChannel(
        context: Context,
        impl: () -> HotUpdaterImpl,
    ): Boolean = resetChannel(context, HotUpdaterInstanceEnvironment.MAIN_NAME, impl)

    /** Clears [name]'s runtime channel once a check or staging of that name finishes. */
    suspend fun resetChannel(
        context: Context,
        name: String,
        impl: () -> HotUpdaterImpl,
    ): Boolean = checker(context, name, impl).resetChannel { impl().resetChannel() }

    /**
     * Clears [name]'s runtime channel, once a check or staging of that name
     * finishes, only while the Release selection [guard] names is current.
     */
    suspend fun resetChannelIfSelectionCurrent(
        context: Context,
        name: String,
        guard: ReleaseSelectionGuard,
        impl: () -> HotUpdaterImpl,
    ): Boolean = checker(context, name, impl).resetChannel { impl().resetChannelIfSelectionCurrent(guard) }
}
