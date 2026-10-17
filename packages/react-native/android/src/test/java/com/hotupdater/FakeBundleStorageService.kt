package com.hotupdater

/** A bundle storage that serves fixed values for [HotUpdaterImpl] tests. */
internal class FakeBundleStorageService(
    private val bundleId: String?,
    private val manifest: Map<String, Any?> = emptyMap(),
    private val baseURL: String = "",
    private val launchedBundleManifests: Map<String, Map<String, Any?>> =
        emptyMap(),
    private val launchedBundleBaseURLs: Map<String, String> = emptyMap(),
    private val nextLaunchBundleId: String? = null,
) : BundleStorageService {
    var lastCompletedBundleId: String? = null

    override fun setBundleURL(localPath: String?): Boolean = true

    override fun getCachedBundleURL(): String? = null

    override fun getFallbackBundleURL(): String = "assets://index.android.bundle"

    override fun peekLaunchBundleId(): String? = nextLaunchBundleId

    override fun prepareLaunch(pendingRecovery: PendingCrashRecovery?): LaunchSelection =
        LaunchSelection(
            bundleUrl = "assets://index.android.bundle",
            launchedBundleId = null,
            shouldRollbackOnCrash = false,
        )

    override suspend fun updateBundle(
        bundleId: String,
        manifestUrl: String,
        manifestFileHash: String,
        assets: Map<String, ChangedAssetDescriptor>,
        archiveUrl: String?,
        fileResolver: ArtifactFileResolver?,
        selection: PersistedSelection?,
        progressCallback: (UpdateProgressPayload) -> Unit,
    ) = UpdateBundleResult(BundleDelivery.MANIFEST, patchFallback = false)

    override fun markLaunchStarted(launchedBundleId: String?) = Unit

    override fun markLaunchCompleted(currentBundleId: String?) {
        lastCompletedBundleId = currentBundleId
    }

    override fun notifyAppReady(): Map<String, Any?> = mapOf("status" to "UNCHANGED")

    override fun getCrashHistory(): CrashedHistory = CrashedHistory()

    override fun clearCrashHistory(): Boolean = true

    override fun getBaseURL(): String = baseURL

    override fun getBaseURLForBundle(bundleId: String?): String =
        if (bundleId == null) {
            ""
        } else {
            launchedBundleBaseURLs[bundleId] ?: ""
        }

    override fun getBundleId(): String? = bundleId

    override fun getManifest(): Map<String, Any?> = manifest

    override fun getManifestForBundle(bundleId: String?): Map<String, Any?> =
        if (bundleId == null) {
            emptyMap()
        } else {
            launchedBundleManifests[bundleId] ?: emptyMap()
        }

    override suspend fun resetChannel(): Boolean = true
}
