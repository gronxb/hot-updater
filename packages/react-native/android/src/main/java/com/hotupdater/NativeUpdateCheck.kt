package com.hotupdater

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CancellationException

/** The native state behind the TurboModule, read and written through [HotUpdaterImpl]. */
internal class HotUpdaterImplUpdateCheckState(
    private val context: Context,
    private val impl: HotUpdaterImpl,
) : UpdateCheckState {
    private val cohortService by lazy { CohortService(context) }

    override fun getAppVersion(): String? = HotUpdaterImpl.getAppVersion(context)

    override fun getBundleId(): String? = impl.getBundleIdForUpdateCheck()

    override fun hasLaunchedBundle(): Boolean = impl.hasLaunchSelection()

    override fun getMinBundleId(): String = HotUpdaterImpl.getMinBundleId()

    override fun getDefaultChannel(): String = impl.getDefaultChannel()

    override fun getChannel(): String = impl.getChannel()

    override fun getCohort(): String = cohortService.getCohort()

    override fun getFingerprintHash(): String? = HotUpdaterImpl.getFingerprintHash(context)

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

/** The process's one native update checker, behind `HotUpdater.checkForUpdate` and `HotUpdater.prepare`. */
internal object NativeUpdateCheck {
    private const val TAG = "HotUpdaterCheck"

    @Volatile
    private var checker: NativeUpdateChecker? = null

    private fun checker(
        context: Context,
        impl: () -> HotUpdaterImpl,
    ): NativeUpdateChecker =
        checker ?: synchronized(this) {
            checker ?: NativeUpdateChecker(
                HotUpdaterImplUpdateCheckState(context.applicationContext, impl()),
                OkHttpUpdateCheckTransport(),
            ).also { checker = it }
        }

    suspend fun checkForUpdate(
        context: Context,
        impl: () -> HotUpdaterImpl,
        options: HotUpdaterCheckOptions,
    ): HotUpdaterUpdate? = checker(context, impl).checkForUpdate(options)

    /** Clears the runtime channel once a check or staging running in this process finishes. */
    suspend fun resetChannel(
        context: Context,
        impl: () -> HotUpdaterImpl,
    ): Boolean = checker(context, impl).whenIdle { impl().resetChannel() }

    suspend fun prepare(
        context: Context,
        impl: () -> HotUpdaterImpl,
        options: HotUpdaterCheckOptions,
        timeoutMillis: Long,
        onProgress: ((Double) -> Unit)?,
    ): HotUpdaterPrepareResult =
        try {
            checker(context, impl).prepare(options, timeoutMillis, onProgress)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            Log.w(TAG, "Failed to prepare an update", error)
            HotUpdaterPrepareResult.Failed(error, null)
        }
}
