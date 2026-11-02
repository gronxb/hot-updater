package com.hotupdater

import android.util.Log
import com.hotupdater.vendor.brotli.dec.BrotliInputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.net.URL
import kotlin.coroutines.cancellation.CancellationException

data class ChangedAssetDescriptor(
    val fileUrl: String?,
    val fileHash: String,
    val fileCompression: String? = null,
    val patch: BsdiffPatchDescriptor? = null,
)

data class BsdiffPatchDescriptor(
    val algorithm: String,
    val baseBundleId: String,
    val baseFileHash: String,
    val patchFileHash: String,
    val patchUrl: String,
    val byteSize: Long? = null,
)

data class UpdateProgressPayload(
    val progress: Double,
    val artifactType: String,
    val details: DiffProgressDetails? = null,
)

data class DiffProgressFileSnapshot(
    val path: String,
    val downloadPath: String = path,
    val status: String,
    val progress: Double,
    val order: Int,
    val downloadedBytes: Long? = null,
    val totalBytes: Long? = null,
)

data class DiffProgressDetails(
    val totalFilesCount: Int,
    val completedFilesCount: Int,
    val files: List<DiffProgressFileSnapshot> = emptyList(),
)

/**
 * How a staged bundle arrived, the `delivery` of the `updateBundle` result:
 * [PATCH] when a bsdiff patch produced at least one file, [MANIFEST] when only
 * the changed files were downloaded (possibly none), and [ARCHIVE] when the
 * full tar.br archive was downloaded.
 */
enum class BundleDelivery(
    val value: String,
) {
    PATCH("patch"),
    MANIFEST("manifest"),
    ARCHIVE("archive"),
}

/**
 * The `updateBundle` result. [patchFallback] is true when a patch for the
 * running bundle could not produce its file, so the whole file was downloaded
 * instead.
 */
data class UpdateBundleResult(
    val delivery: BundleDelivery,
    val patchFallback: Boolean,
)

/**
 * Interface for bundle storage operations
 */
interface BundleStorageService {
    /**
     * Sets the current bundle URL
     * @param localPath Path to the bundle file (or null to reset)
     * @return true if the operation was successful
     */
    fun setBundleURL(localPath: String?): Boolean

    /**
     * Gets the URL to the cached bundle file
     * @return The path to the cached bundle or null if not found
     */
    fun getCachedBundleURL(): String?

    /**
     * Gets the URL to the fallback bundle included in the app
     * @return The fallback bundle path
     */
    fun getFallbackBundleURL(): String

    /**
     * Prepares the bundle launch for the current process.
     * Applies any pending rollback decision from the previous launch and returns
     * the bundle that should be loaded now.
     */
    fun prepareLaunch(pendingRecovery: PendingCrashRecovery?): LaunchSelection

    /**
     * Settles what the previous process left once per process, before the
     * first read of the selection: interrupted promotions, a crash rollback,
     * and a launch that never finished. [prepareLaunch] runs it first; a native
     * update check that runs before React Native starts runs it earlier.
     * [pendingRecovery] is called only when this run settles.
     */
    fun settlePreviousLaunch(pendingRecovery: () -> PendingCrashRecovery?) {}

    /**
     * The bundle [prepareLaunch] would load, read from the saved metadata
     * without preparing the launch. Null is the built-in bundle. Call
     * [settlePreviousLaunch] first, or a bundle the next launch rolls back
     * is returned.
     */
    fun peekLaunchBundleId(): String? = null

    /**
     * Updates the bundle from the specified URL
     * @param bundleId ID of the bundle to update
     * @param manifestUrl URL of the target bundle manifest
     * @param manifestFileHash Manifest hash or signature
     * @param selection the Release selection this staging commits, checked
     *   before the download and again when the staging commits
     * @param progressCallback Callback for download progress updates
     * @return how the staged bundle arrived
     * @throws HotUpdaterException if the update fails
     * @throws StaleReleaseSelectionException if [selection] is no longer current
     */
    suspend fun updateBundle(
        bundleId: String,
        manifestUrl: String,
        manifestFileHash: String,
        assets: Map<String, ChangedAssetDescriptor>,
        archiveUrl: String? = null,
        fileResolver: ArtifactFileResolver? = null,
        selection: PersistedSelection? = null,
        progressCallback: (UpdateProgressPayload) -> Unit,
    ): UpdateBundleResult

    fun acceptReleaseCatalog(
        catalogId: String,
        scopeKey: String,
        generation: Long,
        catalogHash: String,
        channel: String,
        selectionContextHash: String,
    ): Boolean = false

    fun getActiveUpdateState(): Map<String, Any?> = emptyMap()

    fun isReleaseSelectionCurrent(
        catalogId: String,
        scopeKey: String,
        generation: Long,
        catalogHash: String,
        channel: String,
        selectionContextHash: String,
    ): Boolean = false

    suspend fun commitReleaseSelection(selection: PersistedSelection): Boolean = false

    /**
     * Records that the current launch of a verification-pending bundle can show UI.
     * The next process rolls the bundle back unless first content verified it.
     */
    fun markLaunchStarted(launchedBundleId: String?)

    /**
     * Undoes [markLaunchStarted] when another instance's crash ends the
     * process: the launch did not fail, so the next process launches its
     * bundle again instead of counting the launch as unfinished.
     */
    fun clearLaunchStarted(launchedBundleId: String?) {}

    /**
     * Marks the current launch as successful after the first content appeared.
     */
    fun markLaunchCompleted(currentBundleId: String?)

    /**
     * Returns the launch report for the current process.
     */
    fun notifyAppReady(): Map<String, Any?>

    /**
     * Gets the crashed bundle history, plus a bundle that waits for its retry after
     * an unfinished launch while this process still refuses it (see [InterruptedLaunch])
     * @return CrashedHistory containing crashed bundles
     */
    fun getCrashHistory(): CrashedHistory

    /**
     * Clears the crashed bundle history
     * @return true if clearing was successful
     */
    fun clearCrashHistory(): Boolean

    /**
     * Gets the base URL for the current active bundle directory
     * @return Base URL string (e.g., "file:///data/.../bundle-store/abc123") or empty string
     */
    fun getBaseURL(): String

    /**
     * Gets the base URL for a specific launched bundle.
     * Returns an empty string for the built-in bundle or when the bundle is unavailable.
     */
    fun getBaseURLForBundle(bundleId: String?): String

    /**
     * Gets the current active bundle ID from bundle storage.
     */
    fun getBundleId(): String?

    /**
     * Gets the current manifest from bundle storage.
     * Returns an empty map when manifest.json is missing or invalid.
     */
    fun getManifest(): Map<String, Any?>

    /**
     * Gets the manifest for a specific launched bundle.
     * Returns an empty map for the built-in bundle or when the bundle is unavailable.
     */
    fun getManifestForBundle(bundleId: String?): Map<String, Any?>

    /**
     * Restores the original bundle and clears downloaded bundle state.
     * @return true if the reset was successful
     */
    suspend fun resetChannel(): Boolean

    /**
     * Resets the channel only while the named Release selection is current,
     * checked and reset in one critical section with the catalog checks, so
     * a newer catalog accepted meanwhile keeps the channel.
     * @return false for a stale selection
     */
    suspend fun resetChannelIfSelectionCurrent(
        catalogId: String,
        scopeKey: String,
        generation: Long,
        catalogHash: String,
        channel: String,
        selectionContextHash: String,
    ): Boolean = false
}

/**
 * Implementation of BundleStorageService
 */
class BundleFileStorageService(
    private val context: android.content.Context,
    private val fileSystem: FileSystemService,
    private val downloadService: DownloadService,
    private val preferences: PreferencesService,
    private val isolationKey: String,
    private val defaultChannelProvider: () -> String = { HotUpdaterImpl.getChannel(context) },
    private val fingerprintHashProvider: () -> String? = { HotUpdaterImpl.getFingerprintHash(context) },
    // The built-in bundle's ID: the nil UUID in a Debug build, which has none.
    private val minBundleIdProvider: () -> String = { HotUpdaterImpl.getMinBundleId() },
    // The key bundles must be signed with, or null when signing is off.
    private val publicKeyProvider: () -> String? = { SignatureVerifier.getPublicKeyFromConfig(context) },
    private val fallbackBundleURL: String = "assets://index.android.bundle",
    builtInAssetResolver: BuiltInAssetResolver? = null,
    private val metadataWriter: (BundleMetadata, File) -> Boolean = { metadata, file ->
        metadata.saveToFile(file)
    },
    private val directoryRenamer: (File, File) -> Boolean = { source, destination ->
        source.renameTo(destination)
    },
) : BundleStorageService {
    companion object {
        private const val TAG = "BundleStorage"
        private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
        private const val NIL_UUID = "00000000-0000-0000-0000-000000000000"
        private val SHA256_PATTERN = Regex("^[0-9a-f]{64}$")

        /** Files downloaded at once when the archive is not used. */
        private const val PARALLEL_FILE_DOWNLOADS = 16

        /**
         * What one request costs beyond the first [PARALLEL_FILE_DOWNLOADS], in
         * bytes: each waits a round trip for a free slot, about 100 ms, which
         * at 5 MB/s over 16 slots is the time of 32 KiB.
         */
        private const val REQUEST_OVERHEAD_BYTES = 32L * 1024

        /** A patch produced a file that does not match the target, or none at all. */
        private val PATCH_FAILURE =
            UpdateFailure(UpdateFailureStage.INSTALL, UpdateFailureReason.PATCH, resource = UpdateFailureResource.PATCH)
    }

    private val releaseStateLock = Any()
    private val updateMutex = Mutex()
    private val builtInAssetResolver =
        builtInAssetResolver ?: AndroidBuiltInAssetResolver(
            context,
            File(getBundleStoreDir(), "builtin-index-v1.json"),
        )

    private fun createDiffProgressFiles(changedAssets: Map<String, ChangedAssetDescriptor>): MutableList<DiffProgressFileSnapshot> =
        changedAssets.keys
            .sorted()
            .mapIndexed { order, path ->
                DiffProgressFileSnapshot(
                    path = path,
                    downloadPath = path,
                    status = "pending",
                    progress = 0.0,
                    order = order,
                )
            }.toMutableList()

    private fun updateDiffProgressFile(
        files: MutableList<DiffProgressFileSnapshot>,
        assetPath: String,
        status: String,
        progress: Double,
        downloadPath: String? = null,
        downloadedBytes: Long? = null,
        totalBytes: Long? = null,
    ) {
        val fileIndex = files.indexOfFirst { it.path == assetPath }
        if (fileIndex == -1) {
            return
        }

        files[fileIndex] =
            files[fileIndex].copy(
                status = status,
                progress = progress.coerceIn(0.0, 1.0),
                downloadPath = downloadPath ?: files[fileIndex].downloadPath,
                downloadedBytes = downloadedBytes ?: files[fileIndex].downloadedBytes,
                totalBytes = totalBytes ?: files[fileIndex].totalBytes,
            )
    }

    private fun calculateDiffOverallProgress(
        phase: String,
        files: List<DiffProgressFileSnapshot>,
        manifestProgress: Double = 0.0,
    ): Double {
        val normalizedManifestProgress = manifestProgress.coerceIn(0.0, 1.0)
        return when (phase) {
            "manifest" -> {
                normalizedManifestProgress * 0.15
            }

            "downloading" -> {
                if (files.isEmpty()) {
                    0.92
                } else {
                    val completedFilesCount = files.count { it.status == "downloaded" }
                    val activeProgressUnits =
                        files
                            .filter { it.status == "downloading" }
                            .sumOf { it.progress.coerceIn(0.0, 1.0) }
                    (0.2 + ((completedFilesCount + activeProgressUnits) / files.size) * 0.72)
                        .coerceIn(0.2, 0.92)
                }
            }

            "finalizing" -> {
                0.97
            }

            "completed" -> {
                1.0
            }

            else -> {
                0.0
            }
        }
    }

    private fun emitDiffProgress(
        progressCallback: (UpdateProgressPayload) -> Unit,
        phase: String,
        files: List<DiffProgressFileSnapshot>,
        manifestProgress: Double = 0.0,
    ) {
        progressCallback(
            UpdateProgressPayload(
                progress =
                    calculateDiffOverallProgress(
                        phase = phase,
                        files = files,
                        manifestProgress = manifestProgress,
                    ),
                artifactType = "diff",
                details =
                    DiffProgressDetails(
                        totalFilesCount = files.size,
                        completedFilesCount = files.count { it.status == "downloaded" },
                        files = files.toList(),
                    ),
            ),
        )
    }

    private fun resetDiffProgressFile(
        files: MutableList<DiffProgressFileSnapshot>,
        assetPath: String,
        progressCallback: (UpdateProgressPayload) -> Unit,
    ) {
        updateDiffProgressFile(
            files = files,
            assetPath = assetPath,
            status = "pending",
            progress = 0.0,
            downloadPath = assetPath,
        )
        emitDiffProgress(
            progressCallback = progressCallback,
            phase = "downloading",
            files = files,
        )
    }

    private fun patchTempFile(
        tempDir: File,
        assetPath: String,
    ): File {
        val safeName = assetPath.replace("/", "__").replace("\\", "__")
        val patchDir = File(tempDir, "patches")
        patchDir.mkdirs()
        return File(patchDir, "$safeName.bsdiff")
    }

    /**
     * Copies, with no OTA bundle installed, the packaged file each built-in
     * patch was made from, when its bytes are the patch's base: store
     * processing may have changed them. Only these patches are priced and
     * applied; the others fall back to their files.
     */
    private fun prepareBuiltInPatchBases(
        downloads: Map<String, ChangedAssetDescriptor>,
        currentBundleId: String?,
        tempDir: File,
    ): Map<String, File> {
        if (currentBundleId != null) return emptyMap()
        return buildMap {
            for ((assetPath, descriptor) in downloads) {
                val patch = descriptor.patch?.takeIf { isPatchForRunningBundle(it, null) } ?: continue
                val baseFile = patchBaseTempFile(tempDir, assetPath)
                if (builtInAssetResolver.copyIfMatches(assetPath, patch.baseFileHash, baseFile)) {
                    put(assetPath, baseFile)
                } else {
                    baseFile.delete()
                }
            }
        }
    }

    /** Where the built-in bundle's file is copied to serve as a patch's base. */
    private fun patchBaseTempFile(
        tempDir: File,
        assetPath: String,
    ): File {
        val safeName = assetPath.replace("/", "__").replace("\\", "__")
        val patchDir = File(tempDir, "patches")
        patchDir.mkdirs()
        return File(patchDir, "$safeName.base")
    }

    private fun patchDownloadPath(assetPath: String): String = "$assetPath.bsdiff"

    private fun downloadPathForChangedAsset(
        assetPath: String,
        changedAsset: ChangedAssetDescriptor,
    ): String =
        if (changedAsset.fileCompression == "br") {
            "$assetPath.br"
        } else {
            assetPath
        }

    private fun compressedTempFile(
        tempDir: File,
        assetPath: String,
        compression: String,
    ): File {
        val safeName = assetPath.replace("/", "__").replace("\\", "__")
        val compressedDir = File(tempDir, "compressed")
        compressedDir.mkdirs()
        return File(compressedDir, "$safeName.$compression")
    }

    /**
     * Decompresses a downloaded `.br` asset. A decoding failure is reported as
     * an extract failure and a failure writing the output as a storage failure.
     */
    private fun decompressBrotliFile(
        sourceFile: File,
        targetFile: File,
    ) {
        targetFile.parentFile?.mkdirs()
        val tempOutputFile = File(targetFile.parentFile, "${targetFile.name}.tmp")

        if (tempOutputFile.exists()) {
            tempOutputFile.delete()
        }

        try {
            FileInputStream(sourceFile).use { fileInputStream ->
                BrotliInputStream(fileInputStream).use { brotliInputStream ->
                    LocalStorageOutputStream.open(tempOutputFile).use { outputStream ->
                        brotliInputStream.copyTo(outputStream)
                    }
                }
            }

            if (targetFile.exists()) {
                targetFile.delete()
            }
            if (!tempOutputFile.renameTo(targetFile)) {
                storageOperation { tempOutputFile.copyTo(targetFile, overwrite = true) }
                tempOutputFile.delete()
            }
        } catch (error: Exception) {
            tempOutputFile.delete()
            throw HotUpdaterException.downloadFailed(
                error,
                if (error is LocalStorageException) {
                    UpdateFailure.install(UpdateFailureReason.STORAGE)
                } else {
                    UpdateFailure.install(UpdateFailureReason.EXTRACT)
                },
            )
        } catch (error: Throwable) {
            tempOutputFile.delete()
            throw error
        }
    }

    /**
     * Whether [patch] was made against the running bundle: the OTA bundle
     * [currentBundleId], or with none, the built-in bundle, whose ID is
     * MIN_BUNDLE_ID once its native build is registered.
     */
    private fun isPatchForRunningBundle(
        patch: BsdiffPatchDescriptor,
        currentBundleId: String?,
    ): Boolean {
        if (patch.algorithm != "bsdiff") return false
        if (currentBundleId != null) return currentBundleId == patch.baseBundleId
        val builtInBundleId = minBundleIdProvider()
        return builtInBundleId != NIL_UUID && builtInBundleId == patch.baseBundleId
    }

    /**
     * Tries to produce [targetFile] from a bsdiff patch against the running
     * bundle. A patch for another base bundle or algorithm is not attempted.
     * Once attempted, a failure leaves the file to be downloaded instead.
     */
    private suspend fun applyPatchAssetIfPossible(
        assetPath: String,
        changedAsset: ChangedAssetDescriptor,
        currentBundleId: String?,
        activeBundleDir: File?,
        builtInBaseFile: File?,
        targetFile: File,
        expectedHash: String,
        tempDir: File,
        diffFiles: MutableList<DiffProgressFileSnapshot>,
        progressCallback: (UpdateProgressPayload) -> Unit,
    ): PatchOutcome {
        val patch = changedAsset.patch ?: return PatchOutcome.NOT_ATTEMPTED
        if (!isPatchForRunningBundle(patch, currentBundleId)) {
            return PatchOutcome.NOT_ATTEMPTED
        }

        // The patch targets the running bundle, so from here a miss is a fallback.
        val sourceFile: File
        if (currentBundleId == null) {
            // Copied and checked before the plan priced the patch.
            sourceFile = builtInBaseFile ?: return PatchOutcome.FAILED
        } else {
            val sourceDir = activeBundleDir ?: return PatchOutcome.FAILED
            sourceFile = RelativePathResolver.resolveInside(sourceDir, assetPath) ?: return PatchOutcome.FAILED
            if (!sourceFile.exists() || !HashUtils.verifyHash(sourceFile, patch.baseFileHash)) {
                return PatchOutcome.FAILED
            }
        }

        val patchFile = patchTempFile(tempDir, assetPath)

        val patched =
            try {
                when (
                    val patchDownloadResult =
                        downloadService.downloadFile(
                            URL(patch.patchUrl),
                            patchFile,
                        ) { downloadProgress ->
                            updateDiffProgressFile(
                                files = diffFiles,
                                assetPath = assetPath,
                                status = "downloading",
                                progress = downloadProgress.progress,
                                downloadPath = patchDownloadPath(assetPath),
                                downloadedBytes = downloadProgress.downloadedBytes,
                                totalBytes = downloadProgress.totalBytes,
                            )
                            emitDiffProgress(
                                progressCallback = progressCallback,
                                phase = "downloading",
                                files = diffFiles,
                            )
                        }
                ) {
                    is DownloadResult.Error -> {
                        false
                    }

                    is DownloadResult.Success -> {
                        if (!HashUtils.verifyHash(patchDownloadResult.file, patch.patchFileHash)) {
                            false
                        } else {
                            withContext(Dispatchers.IO) {
                                BsdiffPatch.apply(sourceFile, patchDownloadResult.file, targetFile)
                            }
                            HashUtils.verifyHash(targetFile, expectedHash).also { matches ->
                                if (matches) {
                                    Log.d(
                                        TAG,
                                        "HotUpdaterBsdiffPatchApplied asset=$assetPath baseBundleId=${patch.baseBundleId}",
                                    )
                                }
                            }
                        }
                    }
                }
            } catch (_: Exception) {
                false
            } finally {
                patchFile.delete()
                builtInBaseFile?.delete()
                if (!targetFile.exists() || !HashUtils.verifyHash(targetFile, expectedHash)) {
                    targetFile.delete()
                }
            }
        if (!patched) {
            resetDiffProgressFile(
                files = diffFiles,
                assetPath = assetPath,
                progressCallback = progressCallback,
            )
            return PatchOutcome.FAILED
        }
        return PatchOutcome.APPLIED
    }

    private enum class PatchOutcome {
        NOT_ATTEMPTED,
        APPLIED,
        FAILED,
    }

    /** How one file arrived under the per-file plan. */
    private enum class FileDelivery {
        PATCHED,
        DOWNLOADED,
        DOWNLOADED_AFTER_PATCH_FAILURE,
    }

    private data class ParsedBundleManifest(
        val bundleId: String,
        val assets: Map<String, ParsedManifestAsset>,
        val archive: ParsedArchive?,
    )

    private data class ParsedManifestAsset(
        val fileHash: String,
        val signature: String?,
        val byteSize: Long?,
        val downloadByteSize: Long?,
    )

    private data class ParsedArchive(
        val downloadFileHash: String,
        val downloadByteSize: Long,
        val tarByteSize: Long,
    )

    private data class ActiveBundleMetadataSnapshot(
        val activeBundleId: String,
        val bundleId: String?,
        val manifest: Map<String, Any?>,
    )

    init {
        // Ensure bundle store directory exists
        getBundleStoreDir().mkdirs()

        // Clean up old bundles if isolationKey format changed
        checkAndCleanupIfIsolationKeyChanged()

        recoverInterruptedPromotions()
    }

    private var hasPreparedLaunch = false
    private val settleLock = Any()
    private var hasSettledPreviousLaunch = false
    private var currentLaunchReport: LaunchReport? = null

    // The staged bundle this process launched before its first content. Only that
    // launch is pending; a bundle staged later waits for the next launch.
    private var pendingLaunchBundleId: String? = null

    // Crash history is written at first content on the main thread while JS can read it.
    private val crashedHistoryLock = Any()

    // A bundle waiting for its retry that this process keeps refusing, see InterruptedLaunch.
    private var retryHeldBundleId: String? = null

    @Volatile
    private var activeBundleMetadataSnapshot: ActiveBundleMetadataSnapshot? = null
    private val activeBundleMetadataLock = Any()

    // MARK: - Bundle Store Directory

    private fun getBundleStoreDir(): File {
        val baseDir = fileSystem.getInternalFilesDir()
        return File(baseDir, "bundle-store")
    }

    private fun getMetadataFile(): File = File(getBundleStoreDir(), BundleMetadata.METADATA_FILENAME)

    private fun getCrashedHistoryFile(): File = File(getBundleStoreDir(), CrashedHistory.CRASHED_HISTORY_FILENAME)

    private fun getLaunchReportFile(): File = File(getBundleStoreDir(), LaunchReport.LAUNCH_REPORT_FILENAME)

    // MARK: - Metadata Operations

    private fun loadMetadataOrNull(): BundleMetadata? = BundleMetadata.loadFromFile(getMetadataFile(), isolationKey)

    private fun saveMetadata(metadata: BundleMetadata): Boolean {
        val updatedMetadata = metadata.copy(isolationKey = isolationKey)
        return metadataWriter(updatedMetadata, getMetadataFile())
    }

    private fun loadLaunchReport(): LaunchReport? =
        currentLaunchReport ?: LaunchReport.loadFromFile(getLaunchReportFile())?.also {
            currentLaunchReport = it
        }

    private fun saveLaunchReport(report: LaunchReport?) {
        currentLaunchReport = report
        val file = getLaunchReportFile()
        if (report == null) {
            if (file.exists()) {
                file.delete()
            }
            return
        }
        report.saveToFile(file)
    }

    private fun resolveUpdateStrategy(): String =
        try {
            if (fingerprintHashProvider().isNullOrEmpty()) {
                "appVersion"
            } else {
                "fingerprint"
            }
        } catch (_: Exception) {
            "appVersion"
        }

    private fun getKnownLaunchBundleId(metadata: BundleMetadata): String = getCurrentVerifiedBundleId(metadata) ?: minBundleIdProvider()

    private fun createInitialMetadata(): BundleMetadata = BundleMetadata()

    private fun extractBundleIdFromCurrentURL(): String? {
        val currentUrl = preferences.getItem("HotUpdaterBundleURL") ?: return null
        // "bundle-store/abc123/index.android.bundle" -> "abc123"
        val regex = Regex("bundle-store/([^/]+)/")
        return regex.find(currentUrl)?.groupValues?.get(1)
    }

    private fun resolveBundleFile(
        bundleDir: File,
        expectedBundleId: String? = null,
    ): File? {
        val manifestFile = File(bundleDir, "manifest.json")
        if (manifestFile.exists()) {
            val manifest = parseBundleManifestFromFile(manifestFile) ?: return null
            if (expectedBundleId != null && manifest.bundleId != expectedBundleId) {
                return null
            }

            val resolvedAssets =
                manifest.assets.keys.associateWith { assetPath ->
                    RelativePathResolver
                        .resolveInside(bundleDir, assetPath)
                        ?.takeIf { it.isFile }
                        ?: return null
                }
            return resolvedAssets
                .filterKeys { assetPath -> File(assetPath).name.endsWith(".android.bundle") }
                .values
                .singleOrNull()
        }

        return null
    }

    private fun findBundleFile(bundleId: String): File? {
        val bundleDir = File(getBundleStoreDir(), bundleId)
        return resolveBundleFile(bundleDir, bundleId)
    }

    private fun installBackupDir(bundleId: String): File = File(getBundleStoreDir(), "$bundleId.install-backup")

    private fun isCompleteBundleDirectory(
        bundleDir: File,
        bundleId: String,
    ): Boolean {
        val manifest = parseBundleManifestFromFile(File(bundleDir, "manifest.json")) ?: return false
        if (manifest.bundleId != bundleId) return false
        if (resolveBundleFile(bundleDir, bundleId) == null) return false
        return manifest.assets.all { (assetPath, asset) ->
            val file = RelativePathResolver.resolveInside(bundleDir, assetPath)
            file?.isFile == true &&
                (
                    runCatching { verifyManifestAssetFileOrThrow(file, asset) }.isSuccess ||
                        isBuiltInEquivalent(assetPath, file, asset)
                )
        }
    }

    /**
     * Whether [file] holds the packaged bytes of the built-in asset the native
     * build recorded with the manifest's source hash, as AAPT2 re-encodes a
     * PNG. Both come from the APK, never from app storage. The manifest's
     * signature still covers that source hash.
     */
    private fun isBuiltInEquivalent(
        assetPath: String,
        file: File,
        asset: ParsedManifestAsset,
    ): Boolean {
        val packagedHash = builtInAssetResolver.packagedHashIfSourceMatches(assetPath, asset.fileHash) ?: return false
        return HashUtils.calculateSHA256(file).equals(packagedHash, ignoreCase = true) &&
            runCatching {
                val publicKey = publicKeyProvider()
                if (publicKey != null) {
                    val signature = asset.signature ?: throw SignatureVerificationException.InvalidSignatureFormat()
                    SignatureVerifier.verifyHashSignature(publicKey, asset.fileHash, signature)
                }
            }.isSuccess
    }

    private fun recoverInterruptedPromotions(): Boolean {
        val bundleStoreDir = getBundleStoreDir()
        val backups =
            bundleStoreDir.listFiles { file ->
                file.isDirectory && file.name.endsWith(".install-backup")
            } ?: return true

        return backups.all { backupDir ->
            val bundleId = backupDir.name.removeSuffix(".install-backup")
            val finalDir = File(bundleStoreDir, bundleId)
            when {
                !finalDir.exists() -> directoryRenamer(backupDir, finalDir)
                isCompleteBundleDirectory(finalDir, bundleId) -> backupDir.deleteRecursively()
                !finalDir.deleteRecursively() -> false
                else -> directoryRenamer(backupDir, finalDir)
            }
        }
    }

    private fun getBundleUrlForId(bundleId: String): String? = findBundleFile(bundleId)?.absolutePath

    private fun getCurrentVerifiedBundleId(metadata: BundleMetadata): String? =
        when {
            metadata.stagingBundleId != null && !metadata.verificationPending -> metadata.stagingBundleId
            metadata.stableBundleId != null -> metadata.stableBundleId
            else -> null
        }

    private fun getActiveBundleId(): String? {
        val metadata = loadMetadataOrNull() ?: return null
        val cachedBundleId = extractBundleIdFromCurrentURL()
        if (cachedBundleId != null &&
            (cachedBundleId == metadata.stagingBundleId || cachedBundleId == metadata.stableBundleId)
        ) {
            return cachedBundleId
        }
        return when {
            metadata.stagingBundleId != null && !metadata.verificationPending -> metadata.stagingBundleId
            metadata.stableBundleId != null -> metadata.stableBundleId
            else -> null
        }
    }

    private fun getActiveBundleMetadataSnapshot(): ActiveBundleMetadataSnapshot? {
        val activeBundleId =
            getActiveBundleId() ?: run {
                clearActiveBundleMetadataSnapshot()
                return null
            }

        activeBundleMetadataSnapshot
            ?.takeIf { it.activeBundleId == activeBundleId }
            ?.let { return it }

        synchronized(activeBundleMetadataLock) {
            activeBundleMetadataSnapshot
                ?.takeIf { it.activeBundleId == activeBundleId }
                ?.let { return it }

            val bundleDir = File(getBundleStoreDir(), activeBundleId)
            if (!bundleDir.exists()) {
                activeBundleMetadataSnapshot = null
                return null
            }

            return resolveActiveBundleMetadataSnapshot(bundleDir).also {
                activeBundleMetadataSnapshot = it
            }
        }
    }

    private fun clearActiveBundleMetadataSnapshot() {
        synchronized(activeBundleMetadataLock) {
            activeBundleMetadataSnapshot = null
        }
    }

    private fun resolveActiveBundleMetadataSnapshot(bundleDir: File): ActiveBundleMetadataSnapshot {
        val manifest = readManifestFromBundleDir(bundleDir) ?: emptyMap()
        val manifestBundleId =
            (manifest["bundleId"] as? String)
                ?.trim()
                ?.takeIf { it.isNotEmpty() }

        return ActiveBundleMetadataSnapshot(
            activeBundleId = bundleDir.name,
            bundleId = manifestBundleId,
            manifest = manifest,
        )
    }

    private fun getBundleMetadataSnapshot(bundleId: String?): ActiveBundleMetadataSnapshot? {
        if (bundleId.isNullOrBlank()) {
            return null
        }

        val bundleDir = File(getBundleStoreDir(), bundleId)
        if (!bundleDir.exists()) {
            return null
        }

        return resolveActiveBundleMetadataSnapshot(bundleDir)
    }

    private fun readManifestFromBundleDir(bundleDir: File): Map<String, Any?>? {
        val manifestFile = File(bundleDir, "manifest.json")
        if (!manifestFile.exists()) {
            return null
        }

        return try {
            JSONObject(manifestFile.readText()).let(::jsonObjectToMap)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to read manifest from ${manifestFile.absolutePath}: ${e.message}")
            null
        }
    }

    private fun jsonObjectToMap(jsonObject: JSONObject): Map<String, Any?> {
        val result = linkedMapOf<String, Any?>()
        val keys = jsonObject.keys()

        while (keys.hasNext()) {
            val key = keys.next()
            result[key] = jsonValueToKotlin(jsonObject.opt(key))
        }

        return result
    }

    private fun jsonArrayToList(jsonArray: org.json.JSONArray): List<Any?> =
        List(jsonArray.length()) { index ->
            jsonValueToKotlin(jsonArray.opt(index))
        }

    private fun jsonValueToKotlin(value: Any?): Any? =
        when (value) {
            JSONObject.NULL -> null
            is JSONObject -> jsonObjectToMap(value)
            is org.json.JSONArray -> jsonArrayToList(value)
            else -> value
        }

    private fun parseSafeInteger(value: Any?): Long? {
        val parsed =
            when (value) {
                is Byte -> value.toLong()
                is Short -> value.toLong()
                is Int -> value.toLong()
                is Long -> value
                is Float -> value.toDouble().takeIf { it.isFinite() && it % 1.0 == 0.0 }?.toLong()
                is Double -> value.takeIf { it.isFinite() && it % 1.0 == 0.0 }?.toLong()
                else -> null
            } ?: return null
        return parsed.takeIf { it in 0..MAX_SAFE_INTEGER }
    }

    private fun parseArchive(value: Any?): ParsedArchive? {
        val archive = value as? Map<*, *> ?: return null
        val downloadFileHash = archive["downloadFileHash"] as? String ?: return null
        if (!SHA256_PATTERN.matches(downloadFileHash)) return null
        val downloadByteSize = parseSafeInteger(archive["downloadByteSize"])?.takeIf { it > 0 } ?: return null
        val tarByteSize = parseSafeInteger(archive["tarByteSize"])?.takeIf { it >= 1024 } ?: return null
        return ParsedArchive(
            downloadFileHash = downloadFileHash,
            downloadByteSize = downloadByteSize,
            tarByteSize = tarByteSize,
        )
    }

    private fun parseBundleManifestFromMap(manifest: Map<String, Any?>): ParsedBundleManifest? {
        val manifestBundleId =
            (manifest["bundleId"] as? String)
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
                ?: return null
        val assetsValue = manifest["assets"] as? Map<*, *> ?: return null
        val assets = linkedMapOf<String, ParsedManifestAsset>()

        for ((assetPath, assetValue) in assetsValue) {
            if (assetPath !is String) {
                return null
            }
            val normalizedAssetPath = RelativePathResolver.normalizeRelativePath(assetPath)
            if (normalizedAssetPath == null || normalizedAssetPath != assetPath) {
                return null
            }

            val assetMap = assetValue as? Map<*, *> ?: return null
            val fileHash = assetMap["fileHash"] as? String ?: return null
            val signature = assetMap["signature"] as? String
            assets[normalizedAssetPath] =
                ParsedManifestAsset(
                    fileHash = fileHash,
                    signature = signature?.takeIf { it.isNotBlank() },
                    byteSize = parseSafeInteger(assetMap["byteSize"]),
                    downloadByteSize = parseSafeInteger(assetMap["downloadByteSize"]),
                )
        }

        return ParsedBundleManifest(
            bundleId = manifestBundleId,
            assets = assets,
            archive = parseArchive(manifest["archive"]),
        )
    }

    private fun parseBundleManifestFromFile(manifestFile: File): ParsedBundleManifest? {
        if (!manifestFile.exists()) {
            return null
        }

        return try {
            val parsed = JSONObject(manifestFile.readText()).let(::jsonObjectToMap)
            parseBundleManifestFromMap(parsed)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to parse manifest ${manifestFile.absolutePath}: ${e.message}")
            null
        }
    }

    private fun getActiveBundleDir(): File? {
        val activeBundleId = getActiveBundleId() ?: return null
        val bundleDir = File(getBundleStoreDir(), activeBundleId)
        return bundleDir.takeIf { it.exists() }
    }

    private fun copyBundleFile(
        source: File,
        destination: File,
    ) {
        destination.parentFile?.mkdirs()
        source.copyTo(destination, overwrite = true)
    }

    private fun verifyManifestAssetFile(
        file: File,
        asset: ParsedManifestAsset,
    ) {
        val actualHash =
            HashUtils.calculateSHA256(file)
                ?: throw SignatureVerificationException.FileReadFailed()

        if (!actualHash.equals(asset.fileHash, ignoreCase = true)) {
            throw SignatureVerificationException.FileHashMismatch()
        }

        val publicKey = publicKeyProvider() ?: return

        val signature =
            asset.signature
                ?: throw SignatureVerificationException.InvalidSignatureFormat()

        SignatureVerifier.verifyHashSignature(publicKey, asset.fileHash, signature)
    }

    /**
     * @param hashMismatch how a hash mismatch is reported: a downloaded file
     * that does not match is a hash mismatch, while a patched or extracted file
     * that does not match is a patch or extract failure.
     */
    private fun verifyManifestAssetFileOrThrow(
        file: File,
        asset: ParsedManifestAsset,
        hashMismatch: UpdateFailure = UpdateFailure.download(UpdateFailureReason.HASH_MISMATCH),
    ) {
        try {
            verifyManifestAssetFile(file, asset)
        } catch (e: SignatureVerificationException) {
            throw HotUpdaterException.signatureVerificationFailed(
                e,
                if (e is SignatureVerificationException.FileHashMismatch) {
                    hashMismatch
                } else {
                    UpdateFailure.ofVerificationError(e)
                },
            )
        }
    }

    /**
     * Checks if isolationKey has changed and cleans up old bundles if needed.
     * This handles migration when isolationKey format changes.
     */
    private fun checkAndCleanupIfIsolationKeyChanged() {
        val metadataFile = getMetadataFile()

        if (!metadataFile.exists()) {
            // First launch - no cleanup needed
            return
        }

        try {
            // Read metadata without validation to get stored isolationKey
            val jsonString = metadataFile.readText()
            val json = org.json.JSONObject(jsonString)
            val storedIsolationKey = if (json.has("isolationKey")) json.getString("isolationKey") else null

            if (storedIsolationKey != null && storedIsolationKey != isolationKey) {
                // isolationKey changed - migration needed
                Log.d(TAG, "isolationKey changed: $storedIsolationKey -> $isolationKey")
                Log.d(TAG, "Cleaning up old bundles for migration")
                cleanupAllBundlesForMigration()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error checking isolationKey: ${e.message}")
        }
    }

    /**
     * Removes all bundle directories during migration, and the metadata naming them.
     * Called when isolationKey changes, such as when another build is installed.
     */
    private fun cleanupAllBundlesForMigration() {
        val bundleStoreDir = getBundleStoreDir()

        if (!bundleStoreDir.exists()) {
            return
        }

        // Replaced atomically before anything is deleted: a crash after this write
        // leaves only files nothing names, and a failed write changes nothing, so
        // the next start repeats this. Left in place, the old metadata comes back
        // to life when its build is installed again.
        if (!saveMetadata(createInitialMetadata())) {
            Log.e(TAG, "Failed to clear metadata; keeping bundles until the next start")
            return
        }

        try {
            var cleanedCount = 0
            bundleStoreDir.listFiles()?.forEach { file ->
                if (file.isDirectory) {
                    try {
                        if (file.deleteRecursively()) {
                            cleanedCount++
                            Log.d(TAG, "Migration: removed old bundle ${file.name}")
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "Error removing bundle ${file.name}: ${e.message}")
                    }
                }
            }

            Log.d(TAG, "Migration cleanup complete: removed $cleanedCount bundles")
        } catch (e: Exception) {
            Log.e(TAG, "Error during migration cleanup: ${e.message}")
        }
    }

    // MARK: - State Machine

    private fun isVerificationPending(metadata: BundleMetadata): Boolean = metadata.verificationPending && metadata.stagingBundleId != null

    private fun prepareMetadataForNewStagingBundle(
        metadata: BundleMetadata,
        bundleId: String,
        incomingSelection: PersistedSelection?,
    ): BundleMetadata {
        val currentVerifiedBundleId =
            getCurrentVerifiedBundleId(metadata)?.takeIf { it != bundleId }
        if (incomingSelection != null && !isSelectionCurrent(incomingSelection)) {
            throw StaleReleaseSelectionException()
        }
        val currentVerifiedSelection =
            when {
                metadata.stagingBundleId != null && !metadata.verificationPending -> metadata.stagingSelection
                metadata.stableBundleId != null -> metadata.stableSelection
                else -> null
            }?.takeIf { it.bundleId != bundleId }
        val stagingSelection = incomingSelection ?: PersistedSelection.bareBundle(bundleId)
        val fromSelection =
            currentVerifiedSelection
                ?: PersistedSelection.bareBundle(minBundleIdProvider())

        return metadata.copy(
            stableBundleId = currentVerifiedBundleId,
            stagingBundleId = bundleId,
            stableSelection = currentVerifiedSelection,
            stagingSelection = stagingSelection,
            pendingUpdateStrategy = resolveUpdateStrategy(),
            pendingTransition =
                PendingSelectionTransition(
                    fromReleaseId = fromSelection.releaseId,
                    fromBundleId = fromSelection.bundleId,
                    toReleaseId = stagingSelection.releaseId,
                    toBundleId = stagingSelection.bundleId,
                ),
            verificationPending = true,
            launchInProgress = false,
            currentSelectionContexts = contextsAfterCommitting(metadata.currentSelectionContexts, incomingSelection),
            updatedAt = System.currentTimeMillis(),
        )
    }

    /**
     * Rolls back the pending staging bundle. [unfinishedLaunch] means its launch
     * ended before first content without a crash marker.
     */
    private fun rollbackPendingBundle(
        stagingBundleId: String,
        unfinishedLaunch: Boolean = false,
    ): Boolean =
        synchronized(releaseStateLock) {
            rollbackPendingBundleLocked(stagingBundleId, unfinishedLaunch)
        }

    private fun rollbackPendingBundleLocked(
        stagingBundleId: String,
        unfinishedLaunch: Boolean,
    ): Boolean {
        val metadata = loadMetadataOrNull() ?: return false
        if (metadata.stagingBundleId != stagingBundleId) {
            return false
        }

        Log.w(TAG, "Rolling back crashed staging bundle: $stagingBundleId")

        recordFailedLaunch(stagingBundleId, unfinishedLaunch)

        val fallbackBundleId =
            metadata.stableBundleId?.takeIf { candidate ->
                getBundleUrlForId(candidate) != null
            }

        val updatedMetadata =
            metadata.copy(
                stableBundleId = null,
                stagingBundleId = fallbackBundleId,
                stableSelection = null,
                stagingSelection = metadata.stableSelection,
                pendingUpdateStrategy = null,
                pendingTransition = null,
                verificationPending = false,
                launchInProgress = false,
                updatedAt = System.currentTimeMillis(),
            )

        saveMetadata(updatedMetadata)

        val fallbackBundleUrl = fallbackBundleId?.let { getBundleUrlForId(it) }
        setBundleURL(fallbackBundleUrl)

        File(getBundleStoreDir(), stagingBundleId).deleteRecursively()
        saveLaunchReport(
            LaunchReport(
                status = "RECOVERED",
                fromReleaseId = metadata.pendingTransition?.toReleaseId,
                fromBundleId = stagingBundleId,
                toReleaseId = metadata.stableSelection?.releaseId,
                toBundleId = fallbackBundleId ?: minBundleIdProvider(),
                updateStrategy = metadata.pendingUpdateStrategy ?: resolveUpdateStrategy(),
            ),
        )
        return true
    }

    private fun applyPendingRecoveryIfNeeded(pendingRecovery: PendingCrashRecovery?) {
        synchronized(releaseStateLock) {
            val metadata = loadMetadataOrNull() ?: return
            val stagingBundleId = metadata.stagingBundleId ?: return

            if (pendingRecovery?.shouldRollback == true &&
                pendingRecovery.launchedBundleId == stagingBundleId &&
                isVerificationPending(metadata)
            ) {
                rollbackPendingBundle(stagingBundleId)
            }
        }
    }

    private fun selectLaunch(): LaunchSelection = synchronized(releaseStateLock) { selectLaunchLocked() }

    private fun selectLaunchLocked(): LaunchSelection {
        val metadata = loadMetadataOrNull()
        if (metadata == null) {
            return LaunchSelection(
                bundleUrl = getFallbackBundleURL(),
                launchedBundleId = null,
                shouldRollbackOnCrash = false,
            )
        }

        metadata.stagingBundleId?.let { stagingBundleId ->
            val stagingBundleUrl = getBundleUrlForId(stagingBundleId)
            if (stagingBundleUrl != null) {
                return LaunchSelection(
                    bundleUrl = stagingBundleUrl,
                    launchedBundleId = stagingBundleId,
                    shouldRollbackOnCrash = metadata.verificationPending,
                )
            }

            if (metadata.verificationPending && rollbackPendingBundle(stagingBundleId)) {
                return selectLaunchLocked()
            }
        }

        metadata.stableBundleId?.let { stableBundleId ->
            val stableBundleUrl = getBundleUrlForId(stableBundleId)
            if (stableBundleUrl != null) {
                return LaunchSelection(
                    bundleUrl = stableBundleUrl,
                    launchedBundleId = stableBundleId,
                    shouldRollbackOnCrash = false,
                )
            }
        }

        return LaunchSelection(
            bundleUrl = getFallbackBundleURL(),
            launchedBundleId = null,
            shouldRollbackOnCrash = false,
        )
    }

    private fun releaseScopeStateKey(
        catalogId: String,
        scopeKey: String,
    ): String = "$catalogId|$scopeKey"

    /**
     * The selection contexts that stay current once [selection] commits: only
     * its own scope's, or none for a staging without a Release selection. A
     * check made before this commit, of another scope such as another channel,
     * no longer stages over it.
     */
    private fun contextsAfterCommitting(
        contexts: Map<String, String>,
        selection: PersistedSelection?,
    ): Map<String, String> {
        val catalogId = selection?.catalogId ?: return emptyMap()
        val scopeKey = selection.scopeKey ?: return emptyMap()
        val stateKey = releaseScopeStateKey(catalogId, scopeKey)
        return contexts.filterKeys { it == stateKey }
    }

    private fun selectionContextValue(
        channel: String,
        selectionContextHash: String,
    ): String = "$channel\n$selectionContextHash"

    override fun acceptReleaseCatalog(
        catalogId: String,
        scopeKey: String,
        generation: Long,
        catalogHash: String,
        channel: String,
        selectionContextHash: String,
    ): Boolean =
        synchronized(releaseStateLock) {
            val metadata = loadMetadataOrNull() ?: createInitialMetadata()
            val stateKey = releaseScopeStateKey(catalogId, scopeKey)
            val highestSeen = metadata.highestSeenCatalogs[stateKey]
            if (highestSeen != null && generation < highestSeen.generation) {
                return@synchronized false
            }
            if (
                highestSeen != null &&
                generation == highestSeen.generation &&
                catalogHash != highestSeen.catalogHash
            ) {
                return@synchronized false
            }

            val highWaters = metadata.highestSeenCatalogs.toMutableMap()
            highWaters[stateKey] = CatalogHighWater(generation, catalogHash)
            val contexts = metadata.currentSelectionContexts.toMutableMap()
            contexts[stateKey] = selectionContextValue(channel, selectionContextHash)
            saveMetadata(
                metadata.copy(
                    highestSeenCatalogs = highWaters,
                    currentSelectionContexts = contexts,
                    updatedAt = System.currentTimeMillis(),
                ),
            )
        }

    private fun activeSelection(metadata: BundleMetadata): PersistedSelection? =
        metadata.stagingSelection
            ?: metadata.stagingBundleId?.let(PersistedSelection::bareBundle)
            ?: metadata.stableSelection
            ?: metadata.stableBundleId?.let(PersistedSelection::bareBundle)

    override fun getActiveUpdateState(): Map<String, Any?> =
        synchronized(releaseStateLock) {
            val metadata = loadMetadataOrNull()
            mapOf(
                "activeSelection" to metadata?.let(::activeSelection)?.toMap(),
                "stableSelection" to metadata?.stableSelection?.toMap(),
                "verificationPending" to (metadata?.verificationPending ?: false),
                "highestSeenCatalogs" to
                    (metadata?.highestSeenCatalogs ?: emptyMap()).mapValues { (_, value) ->
                        mapOf(
                            "generation" to value.generation.toDouble(),
                            "catalogHash" to value.catalogHash,
                        )
                    },
            )
        }

    override fun isReleaseSelectionCurrent(
        catalogId: String,
        scopeKey: String,
        generation: Long,
        catalogHash: String,
        channel: String,
        selectionContextHash: String,
    ): Boolean =
        synchronized(releaseStateLock) {
            val metadata = loadMetadataOrNull() ?: return@synchronized false
            val stateKey = releaseScopeStateKey(catalogId, scopeKey)
            metadata.highestSeenCatalogs[stateKey] == CatalogHighWater(generation, catalogHash) &&
                metadata.currentSelectionContexts[stateKey] ==
                selectionContextValue(channel, selectionContextHash)
        }

    private fun isSelectionCurrent(selection: PersistedSelection): Boolean {
        val catalogId = selection.catalogId ?: return false
        val scopeKey = selection.scopeKey ?: return false
        val generation = selection.generation ?: return false
        val catalogHash = selection.catalogHash ?: return false
        val selectionContextHash = selection.selectionContextHash ?: return false
        return isReleaseSelectionCurrent(
            catalogId = catalogId,
            scopeKey = scopeKey,
            generation = generation,
            catalogHash = catalogHash,
            channel = selection.channel,
            selectionContextHash = selectionContextHash,
        )
    }

    override suspend fun commitReleaseSelection(selection: PersistedSelection): Boolean =
        withContext(Dispatchers.IO) {
            synchronized(releaseStateLock) {
                if (!isSelectionCurrent(selection)) return@synchronized false
                val metadata = loadMetadataOrNull() ?: createInitialMetadata()
                val nextMetadata =
                    if (selection.kind == "BUNDLE") {
                        when {
                            metadata.stagingSelection?.bundleId == selection.bundleId ||
                                metadata.stagingBundleId == selection.bundleId -> {
                                metadata.copy(
                                    stagingBundleId = selection.bundleId,
                                    stagingSelection = selection,
                                    // The launch of the staged bundle reports this Release as applied.
                                    pendingTransition =
                                        metadata.pendingTransition?.let { transition ->
                                            if (transition.toBundleId == selection.bundleId) {
                                                transition.copy(toReleaseId = selection.releaseId)
                                            } else {
                                                transition
                                            }
                                        },
                                    updatedAt = System.currentTimeMillis(),
                                )
                            }

                            metadata.stableSelection?.bundleId == selection.bundleId ||
                                metadata.stableBundleId == selection.bundleId -> {
                                metadata.copy(
                                    stableBundleId = selection.bundleId,
                                    stableSelection = selection,
                                    updatedAt = System.currentTimeMillis(),
                                )
                            }

                            else -> {
                                return@synchronized false
                            }
                        }
                    } else {
                        setBundleURL(null)
                        metadata.copy(
                            stableBundleId = null,
                            stableSelection = null,
                            stagingBundleId = null,
                            stagingSelection = selection,
                            pendingUpdateStrategy = null,
                            pendingTransition = null,
                            verificationPending = false,
                            launchInProgress = false,
                            updatedAt = System.currentTimeMillis(),
                        )
                    }
                val committedMetadata =
                    nextMetadata.copy(
                        currentSelectionContexts = contextsAfterCommitting(nextMetadata.currentSelectionContexts, selection),
                    )
                if (!saveMetadata(committedMetadata)) return@synchronized false

                if (selection.channel == defaultChannelProvider()) {
                    preferences.setItem("HotUpdaterChannel", null)
                } else {
                    preferences.setItem("HotUpdaterChannel", selection.channel)
                }
                if (selection.kind != "BUNDLE") {
                    getBundleStoreDir().listFiles()?.forEach { file ->
                        if (file.isDirectory) file.deleteRecursively()
                    }
                }
                true
            }
        }

    // MARK: - Crashed History

    private fun loadCrashedHistory(): CrashedHistory = CrashedHistory.loadFromFile(getCrashedHistoryFile())

    private fun saveCrashedHistory(history: CrashedHistory): Boolean = history.saveToFile(getCrashedHistoryFile())

    private fun isBundleInCrashedHistory(bundleId: String): Boolean = getCrashHistory().contains(bundleId)

    /**
     * The bundles this device refuses to install: crash history, plus a bundle
     * waiting for its retry until a process that may retry it.
     */
    override fun getCrashHistory(): CrashedHistory =
        synchronized(crashedHistoryLock) {
            val history = loadCrashedHistory()
            val interrupted = history.interruptedLaunch
            if (interrupted != null &&
                (!interrupted.retryReady || interrupted.bundleId == retryHeldBundleId) &&
                !history.contains(interrupted.bundleId)
            ) {
                history.bundles.add(CrashedBundleEntry(interrupted.bundleId, crashedAt = System.currentTimeMillis()))
            }
            history
        }

    override fun clearCrashHistory(): Boolean {
        synchronized(crashedHistoryLock) {
            saveCrashedHistory(CrashedHistory())
            retryHeldBundleId = null
        }
        Log.d(TAG, "Cleared crash history")
        return true
    }

    /**
     * A crash, or a second unfinished launch of the same bundle, adds the bundle to
     * crash history. A first unfinished launch cannot tell a hang from a user leaving
     * early, so it leaves the bundle one retry instead.
     */
    private fun recordFailedLaunch(
        bundleId: String,
        unfinishedLaunch: Boolean,
    ) {
        synchronized(crashedHistoryLock) {
            val history = loadCrashedHistory()
            val interrupted = history.interruptedLaunch
            if (unfinishedLaunch && interrupted?.bundleId != bundleId) {
                Log.w(TAG, "Launch of $bundleId ended before first content; it gets one retry")
                history.interruptedLaunch = InterruptedLaunch(bundleId)
                retryHeldBundleId = bundleId
            } else {
                history.addEntry(bundleId)
                if (interrupted?.bundleId == bundleId) {
                    history.interruptedLaunch = null
                }
            }
            saveCrashedHistory(history)
        }
    }

    /**
     * First content appeared, so the app works again. A bundle waiting for its retry
     * may be installed from the next process on. This process keeps refusing it, so
     * the session that recovered never reloads into it. Content from that bundle
     * verifies it.
     */
    private fun readyInterruptedLaunchRetry(currentBundleId: String?) {
        synchronized(crashedHistoryLock) {
            val history = loadCrashedHistory()
            val interrupted = history.interruptedLaunch ?: return
            if (interrupted.bundleId == currentBundleId) {
                history.interruptedLaunch = null
            } else if (interrupted.retryReady) {
                return
            } else {
                history.interruptedLaunch = interrupted.copy(retryReady = true)
                retryHeldBundleId = interrupted.bundleId
            }
            saveCrashedHistory(history)
        }
    }

    override fun markLaunchStarted(launchedBundleId: String?) {
        // Unlike prepareLaunch, this can run while JS stages a newer bundle.
        synchronized(releaseStateLock) {
            val metadata = loadMetadataOrNull() ?: return
            if (!isVerificationPending(metadata) ||
                metadata.launchInProgress ||
                metadata.stagingBundleId != launchedBundleId
            ) {
                return
            }
            saveMetadata(metadata.copy(launchInProgress = true))
        }
    }

    override fun clearLaunchStarted(launchedBundleId: String?) {
        synchronized(releaseStateLock) {
            val metadata = loadMetadataOrNull() ?: return
            if (!metadata.launchInProgress || metadata.stagingBundleId != launchedBundleId) {
                return
            }
            saveMetadata(metadata.copy(launchInProgress = false))
        }
    }

    override fun markLaunchCompleted(currentBundleId: String?) {
        readyInterruptedLaunchRetry(currentBundleId)
        // A Release selection can commit at the same time, from a native update
        // check or JS; neither may save over the other's read.
        synchronized(releaseStateLock) {
            val metadata = loadMetadataOrNull() ?: return
            val stagingBundleId = metadata.stagingBundleId ?: return
            if (!metadata.verificationPending || stagingBundleId != currentBundleId) {
                return
            }

            val transition = metadata.pendingTransition
            val fromBundleId = transition?.fromBundleId ?: getKnownLaunchBundleId(metadata)
            saveMetadata(
                metadata.copy(
                    stableBundleId = null,
                    stableSelection = null,
                    pendingUpdateStrategy = null,
                    pendingTransition = null,
                    verificationPending = false,
                    launchInProgress = false,
                    updatedAt = System.currentTimeMillis(),
                ),
            )
            saveLaunchReport(
                LaunchReport(
                    status = "UPDATE_APPLIED",
                    fromReleaseId = transition?.fromReleaseId,
                    fromBundleId = fromBundleId,
                    toReleaseId = transition?.toReleaseId,
                    toBundleId = stagingBundleId,
                    updateStrategy = metadata.pendingUpdateStrategy ?: resolveUpdateStrategy(),
                ),
            )
        }
    }

    // MARK: - notifyAppReady

    override fun notifyAppReady(): Map<String, Any?> {
        val report = loadLaunchReport()
        if (report == null) {
            val metadata = loadMetadataOrNull()
            val launchedBundleId = pendingLaunchBundleId
            if (launchedBundleId != null &&
                metadata?.verificationPending == true &&
                metadata.stagingBundleId == launchedBundleId
            ) {
                return mapOf("status" to "PENDING")
            }
            return mapOf("status" to "UNCHANGED")
        }
        return buildMap {
            put("status", report.status)
            report.fromReleaseId?.let { put("fromReleaseId", it) }
            report.fromBundleId?.let { put("fromBundleId", it) }
            report.toReleaseId?.let { put("toReleaseId", it) }
            report.toBundleId?.let { put("toBundleId", it) }
            report.updateStrategy?.let { put("updateStrategy", it) }
        }
    }

    // MARK: - Bundle URL Operations

    override fun setBundleURL(localPath: String?): Boolean {
        Log.d(TAG, "setBundleURL: $localPath")
        return try {
            preferences.setItem("HotUpdaterBundleURL", localPath)
            clearActiveBundleMetadataSnapshot()
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to persist bundle URL", e)
            false
        }
    }

    override fun getCachedBundleURL(): String? {
        val urlString = preferences.getItem("HotUpdaterBundleURL")
        Log.d(TAG, "getCachedBundleURL: read from prefs = $urlString")
        if (urlString.isNullOrEmpty()) {
            Log.d(TAG, "getCachedBundleURL: urlString is null or empty")
            return null
        }

        val cachedBundleId = extractBundleIdFromCurrentURL()
        val resolvedBundle = cachedBundleId?.let(::findBundleFile)
        val isValid =
            if (cachedBundleId == null) {
                File(urlString).isFile
            } else {
                resolvedBundle != null
            }
        Log.d(TAG, "getCachedBundleURL: cached bundle valid = $isValid at path: $urlString")
        if (!isValid) {
            preferences.setItem("HotUpdaterBundleURL", null)
            Log.d(TAG, "getCachedBundleURL: cached bundle is invalid, cleared preference")
            return null
        }
        return resolvedBundle?.absolutePath ?: urlString
    }

    override fun getFallbackBundleURL(): String = fallbackBundleURL

    override fun settlePreviousLaunch(pendingRecovery: () -> PendingCrashRecovery?) {
        synchronized(settleLock) {
            if (hasSettledPreviousLaunch) return
            hasSettledPreviousLaunch = true
            recoverInterruptedPromotions()
            // Cleared before the rollbacks below, so the launch reports their RECOVERED.
            saveLaunchReport(null)
            applyPendingRecoveryIfNeeded(pendingRecovery())
            synchronized(releaseStateLock) {
                // Only a new storage instance consumes an unfinished launch. Repeated bundle
                // lookups or bridge reloads in this process must not reject its own launch.
                val metadata = loadMetadataOrNull()
                if (metadata?.verificationPending == true && metadata.launchInProgress) {
                    metadata.stagingBundleId?.let { rollbackPendingBundle(it, unfinishedLaunch = true) }
                }
                // A pending bundle whose file is gone rolls back, as selectLaunch does.
                val settled = loadMetadataOrNull()
                settled?.stagingBundleId?.let { stagingBundleId ->
                    if (settled.verificationPending && getBundleUrlForId(stagingBundleId) == null) {
                        rollbackPendingBundle(stagingBundleId)
                    }
                }
                forgetVerifiedBundlesWithoutFiles()
            }
        }
    }

    /**
     * Drops a verified bundle whose files are gone. The launch already skips it,
     * so the state then says what runs, and a check installs the Release instead
     * of adopting files that do not exist. It did not fail, so unlike a pending
     * bundle's rollback this adds nothing to crash history. A released version's
     * isolation key cleanup left such metadata for a later build of the same key.
     */
    private fun forgetVerifiedBundlesWithoutFiles() {
        val metadata = loadMetadataOrNull() ?: return

        fun isGone(
            bundleId: String?,
            selection: PersistedSelection?,
        ): Boolean {
            // A rollback can leave a selection without its id. A BUILTIN selection
            // has no files by design.
            val named = bundleId ?: selection?.takeIf { it.kind == "BUNDLE" }?.bundleId ?: return false
            return named != minBundleIdProvider() && getBundleUrlForId(named) == null
        }
        val stagingIsGone = !metadata.verificationPending && isGone(metadata.stagingBundleId, metadata.stagingSelection)
        val stableIsGone = isGone(metadata.stableBundleId, metadata.stableSelection)
        if (!stagingIsGone && !stableIsGone) return

        saveMetadata(
            metadata.copy(
                stagingBundleId = metadata.stagingBundleId.takeUnless { stagingIsGone },
                stagingSelection = metadata.stagingSelection.takeUnless { stagingIsGone },
                stableBundleId = metadata.stableBundleId.takeUnless { stableIsGone },
                stableSelection = metadata.stableSelection.takeUnless { stableIsGone },
                updatedAt = System.currentTimeMillis(),
            ),
        )
    }

    override fun prepareLaunch(pendingRecovery: PendingCrashRecovery?): LaunchSelection {
        if (hasPreparedLaunch) {
            // A later launch in this process, after a reset or a reload.
            recoverInterruptedPromotions()
            saveLaunchReport(null)
            applyPendingRecoveryIfNeeded(pendingRecovery)
        } else {
            settlePreviousLaunch { pendingRecovery }
        }
        hasPreparedLaunch = true

        // A launch is recorded only once it can show UI (markLaunchStarted).
        val selection = selectLaunch()
        pendingLaunchBundleId = selection.launchedBundleId.takeIf { selection.shouldRollbackOnCrash }
        Log.d(
            TAG,
            "prepareLaunch: bundleId=${selection.launchedBundleId} shouldRollback=${selection.shouldRollbackOnCrash} url=${selection.bundleUrl}",
        )
        return selection
    }

    override fun peekLaunchBundleId(): String? {
        val metadata = loadMetadataOrNull() ?: return null
        metadata.stagingBundleId?.let { stagingBundleId ->
            if (getBundleUrlForId(stagingBundleId) != null) return stagingBundleId
        }
        metadata.stableBundleId?.let { stableBundleId ->
            if (getBundleUrlForId(stableBundleId) != null) return stableBundleId
        }
        return null
    }

    override suspend fun updateBundle(
        bundleId: String,
        manifestUrl: String,
        manifestFileHash: String,
        assets: Map<String, ChangedAssetDescriptor>,
        archiveUrl: String?,
        fileResolver: ArtifactFileResolver?,
        selection: PersistedSelection?,
        progressCallback: (UpdateProgressPayload) -> Unit,
    ): UpdateBundleResult =
        updateMutex.withLock {
            // The selection travels with this staging: another staging of the
            // same bundle carries its own.
            if (selection != null && !isSelectionCurrent(selection)) {
                throw StaleReleaseSelectionException()
            }
            updateBundleSerialized(
                bundleId = bundleId,
                manifestUrl = manifestUrl,
                manifestFileHash = manifestFileHash,
                changedAssets = assets,
                archiveUrl = archiveUrl,
                fileResolver = fileResolver,
                selection = selection,
                progressCallback = progressCallback,
            )
        }

    private suspend fun updateBundleSerialized(
        bundleId: String,
        manifestUrl: String,
        manifestFileHash: String,
        changedAssets: Map<String, ChangedAssetDescriptor>,
        archiveUrl: String?,
        fileResolver: ArtifactFileResolver?,
        selection: PersistedSelection?,
        progressCallback: (UpdateProgressPayload) -> Unit,
    ): UpdateBundleResult {
        Log.d(
            TAG,
            "updateBundle bundleId $bundleId manifestUrl $manifestUrl",
        )

        // Check if bundle is in crashed history
        if (isBundleInCrashedHistory(bundleId)) {
            Log.w(TAG, "Bundle $bundleId is in crashed history, rejecting update")
            throw HotUpdaterException.bundleInCrashedHistory(bundleId)
        }

        val bundleStoreDir = getBundleStoreDir()
        updateStep(UpdateFailureStage.INSTALL, resource = null) {
            if (!bundleStoreDir.exists()) {
                bundleStoreDir.mkdirs()
            }
            if (!recoverInterruptedPromotions()) {
                throw HotUpdaterException.moveOperationFailed()
            }
        }

        val finalBundleDir = File(bundleStoreDir, bundleId)
        return withContext(Dispatchers.IO) {
            updateBundleFromManifest(
                bundleId = bundleId,
                manifestUrl = manifestUrl,
                manifestFileHash = manifestFileHash,
                changedAssets = changedAssets,
                archiveUrl = archiveUrl,
                fileResolver = fileResolver,
                selection = selection,
                bundleStoreDir = bundleStoreDir,
                finalBundleDir = finalBundleDir,
                progressCallback = progressCallback,
            )
        }
    }

    /**
     * Runs one step of the update pipeline and gives its failure a
     * classification for JS: [resource] is what the step fetches or applies,
     * and an error nothing anticipated is reported as unknown in [stage].
     */
    private inline fun <T> updateStep(
        stage: UpdateFailureStage,
        resource: UpdateFailureResource?,
        block: () -> T,
    ): T =
        try {
            block()
        } catch (e: Exception) {
            throw classifyUpdateFailure(e, stage, resource)
        }

    /**
     * Gives a failure of the update pipeline its classification for JS.
     * Failures that are not update failures pass through unchanged, and an
     * already classified failure only gains a [resource] it did not name.
     */
    private fun classifyUpdateFailure(
        error: Exception,
        stage: UpdateFailureStage,
        resource: UpdateFailureResource?,
    ): Exception =
        when (error) {
            is StaleReleaseSelectionException, is CancellationException -> {
                error
            }

            is HotUpdaterException -> {
                error.withResource(resource)
            }

            else -> {
                HotUpdaterException.unexpected(
                    error,
                    UpdateFailure.ofUnexpectedError(error, stage).copy(resource = resource),
                )
            }
        }

    /**
     * Asks [fileResolver] for the URLs of [downloads], in requests of at most
     * [ArtifactFileResolver.ARTIFACT_FILES_REQUEST_LIMIT] paths.
     */
    private suspend fun resolveFileUrls(
        fileResolver: ArtifactFileResolver,
        downloads: MutableMap<String, ChangedAssetDescriptor>,
    ) {
        for (paths in downloads.keys.sorted().chunked(ArtifactFileResolver.ARTIFACT_FILES_REQUEST_LIMIT)) {
            val files =
                try {
                    fileResolver.resolve(paths)
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    throw downloadError(error)
                }
            for (path in paths) {
                val file = files[path] ?: throw HotUpdaterException.invalidBundle()
                val url =
                    try {
                        URL(file.url)
                    } catch (error: java.net.MalformedURLException) {
                        throw HotUpdaterException.invalidFileUrl(path, file.url, UpdateFailureResource.FILE)
                    }
                // java.net.URL also takes file: URLs and a hostless "https://"; a download needs neither.
                if (url.protocol.lowercase() !in setOf("http", "https") || url.host.isNullOrEmpty()) {
                    throw HotUpdaterException.invalidFileUrl(path, file.url, UpdateFailureResource.FILE)
                }
                downloads[path] = downloads.getValue(path).copy(fileUrl = file.url, fileCompression = file.compression)
            }
        }
    }

    /** The rejection for a download that returned [error]. */
    private fun downloadError(error: Exception): HotUpdaterException =
        if (error is IncompleteDownloadException) {
            HotUpdaterException.incompleteDownload(error.expectedSize, error.actualSize)
        } else {
            HotUpdaterException.downloadFailed(
                error,
                UpdateFailure.ofDownloadError(error) { NetworkState.hasNoActiveNetwork(context) },
            )
        }

    private suspend fun downloadManifestAsset(
        assetPath: String,
        expectedAsset: ParsedManifestAsset,
        changedAsset: ChangedAssetDescriptor,
        currentBundleId: String?,
        activeBundleDir: File?,
        builtInBaseFile: File?,
        targetFile: File,
        tempDir: File,
        progressFile: DiffProgressFileSnapshot,
        progressCallback: (UpdateProgressPayload) -> Unit,
    ): FileDelivery {
        val expectedHash = expectedAsset.fileHash
        val diffFiles = mutableListOf(progressFile)
        val patchOutcome =
            applyPatchAssetIfPossible(
                assetPath = assetPath,
                changedAsset = changedAsset,
                currentBundleId = currentBundleId,
                activeBundleDir = activeBundleDir,
                builtInBaseFile = builtInBaseFile,
                targetFile = targetFile,
                expectedHash = expectedHash,
                tempDir = tempDir,
                diffFiles = diffFiles,
                progressCallback = progressCallback,
            )
        if (patchOutcome == PatchOutcome.APPLIED) {
            verifyManifestAssetFileOrThrow(
                targetFile,
                expectedAsset,
                hashMismatch = PATCH_FAILURE,
            )
            updateDiffProgressFile(
                files = diffFiles,
                assetPath = assetPath,
                status = "downloaded",
                progress = 1.0,
            )
            emitDiffProgress(
                progressCallback = progressCallback,
                phase =
                    if (diffFiles.all { it.status == "downloaded" }) {
                        "finalizing"
                    } else {
                        "downloading"
                    },
                files = diffFiles,
            )
            return FileDelivery.PATCHED
        }

        val changedAssetFileUrl =
            changedAsset.fileUrl
                ?: run {
                    updateDiffProgressFile(
                        files = diffFiles,
                        assetPath = assetPath,
                        status = "failed",
                        progress = 0.0,
                    )
                    emitDiffProgress(
                        progressCallback = progressCallback,
                        phase = "downloading",
                        files = diffFiles,
                    )
                    throw HotUpdaterException.downloadFailed(
                        IllegalStateException("Changed asset fileUrl missing and patch could not be applied: $assetPath"),
                        PATCH_FAILURE,
                    )
                }

        val downloadPath = downloadPathForChangedAsset(assetPath, changedAsset)
        val downloadedAssetFile =
            if (changedAsset.fileCompression == "br") {
                compressedTempFile(tempDir, assetPath, "br")
            } else {
                targetFile
            }

        when (
            val assetDownloadResult =
                downloadService.downloadFile(
                    URL(changedAssetFileUrl),
                    downloadedAssetFile,
                ) { downloadProgress ->
                    updateDiffProgressFile(
                        files = diffFiles,
                        assetPath = assetPath,
                        status = "downloading",
                        progress = downloadProgress.progress,
                        downloadPath = downloadPath,
                        downloadedBytes = downloadProgress.downloadedBytes,
                        totalBytes = downloadProgress.totalBytes,
                    )
                    emitDiffProgress(
                        progressCallback = progressCallback,
                        phase = "downloading",
                        files = diffFiles,
                    )
                }
        ) {
            is DownloadResult.Error -> {
                updateDiffProgressFile(
                    files = diffFiles,
                    assetPath = assetPath,
                    status = "failed",
                    progress =
                        diffFiles
                            .firstOrNull { it.path == assetPath }
                            ?.progress ?: 0.0,
                )
                emitDiffProgress(
                    progressCallback = progressCallback,
                    phase = "downloading",
                    files = diffFiles,
                )
                throw downloadError(assetDownloadResult.exception)
            }

            is DownloadResult.Success -> {
                try {
                    if (changedAsset.fileCompression == "br") {
                        decompressBrotliFile(
                            assetDownloadResult.file,
                            targetFile,
                        )
                    }
                    verifyManifestAssetFileOrThrow(
                        targetFile,
                        expectedAsset,
                    )
                } catch (e: Exception) {
                    updateDiffProgressFile(
                        files = diffFiles,
                        assetPath = assetPath,
                        status = "failed",
                        progress = 1.0,
                    )
                    emitDiffProgress(
                        progressCallback = progressCallback,
                        phase = "downloading",
                        files = diffFiles,
                    )
                    if (e is HotUpdaterException) {
                        throw e
                    }
                    // The bytes arrived; what failed is reading them back.
                    throw HotUpdaterException.downloadFailed(
                        e,
                        UpdateFailure.ofUnexpectedError(e, UpdateFailureStage.DOWNLOAD),
                    )
                } finally {
                    if (changedAsset.fileCompression == "br") {
                        assetDownloadResult.file.delete()
                    }
                }
                updateDiffProgressFile(
                    files = diffFiles,
                    assetPath = assetPath,
                    status = "downloaded",
                    progress = 1.0,
                )
                emitDiffProgress(
                    progressCallback = progressCallback,
                    phase = if (diffFiles.all { it.status == "downloaded" }) "finalizing" else "downloading",
                    files = diffFiles,
                )
            }
        }
        return if (patchOutcome == PatchOutcome.FAILED) {
            FileDelivery.DOWNLOADED_AFTER_PATCH_FAILURE
        } else {
            FileDelivery.DOWNLOADED
        }
    }

    private fun pruneStagingDirectory(
        directory: File,
        assets: Set<String>,
        prefix: String = "",
    ) {
        directory.listFiles()?.forEach { file ->
            val relativePath = prefix + file.name
            if (file.canonicalFile != File(directory.canonicalFile, file.name)) {
                if (!file.delete()) {
                    throw HotUpdaterException.storageFailed("Cannot remove staging link: $relativePath")
                }
            } else if (file.isDirectory && assets.any { it.startsWith("$relativePath/") }) {
                pruneStagingDirectory(file, assets, "$relativePath/")
            } else if (!file.isFile || relativePath !in assets) {
                if (!file.deleteRecursively()) {
                    throw HotUpdaterException.storageFailed("Cannot remove stale staging file: $relativePath")
                }
            }
        }
    }

    private fun selectArchive(
        manifest: ParsedBundleManifest,
        downloads: Map<String, ChangedAssetDescriptor>,
        archiveUrl: String?,
        currentBundleId: String?,
        builtInPatchBases: Map<String, File>,
    ): ParsedArchive? {
        if (archiveUrl.isNullOrBlank() || downloads.size < 2) return null
        val archive = manifest.archive ?: return null
        if (manifest.assets.values.any { it.byteSize == null }) return null

        // Only a patch this device applies saves bytes.
        val applicablePatches =
            downloads.mapValues { (assetPath, descriptor) ->
                descriptor.patch?.takeIf {
                    if (currentBundleId == null) {
                        assetPath in builtInPatchBases
                    } else {
                        isPatchForRunningBundle(it, currentBundleId)
                    }
                }
            }
        var individualBytes = 0L
        for ((assetPath, patch) in applicablePatches) {
            val originalBytes = manifest.assets.getValue(assetPath).downloadByteSize ?: return null
            val expectedBytes =
                if (patch == null) {
                    originalBytes
                } else {
                    val patchBytes = patch.byteSize?.takeIf { it in 0..MAX_SAFE_INTEGER } ?: return null
                    minOf(originalBytes, patchBytes)
                }
            if (individualBytes > MAX_SAFE_INTEGER - expectedBytes) return null
            individualBytes += expectedBytes
        }
        var logicalBytes = 0L
        for (asset in manifest.assets.values) {
            val byteSize = asset.byteSize ?: return null
            if (logicalBytes > MAX_SAFE_INTEGER - byteSize) return null
            logicalBytes += byteSize
        }
        if (archive.tarByteSize < logicalBytes) return null
        val tarFramingBytes = archive.tarByteSize - logicalBytes
        // Many small files cost more in requests than in bytes.
        val requestOverheadBytes =
            (downloads.size - PARALLEL_FILE_DOWNLOADS).coerceAtLeast(0) * REQUEST_OVERHEAD_BYTES
        if (individualBytes > MAX_SAFE_INTEGER - requestOverheadBytes) return null
        val individualCost = individualBytes + requestOverheadBytes
        if (individualCost > MAX_SAFE_INTEGER - tarFramingBytes) return null
        val framedByteLimit = individualCost + tarFramingBytes

        if (archive.downloadByteSize <= individualCost) return archive
        if (downloads.size != manifest.assets.size || applicablePatches.values.any { it != null }) return null
        return archive.takeIf { it.downloadByteSize <= framedByteLimit }
    }

    private suspend fun tryInstallArchive(
        archiveUrl: String,
        archive: ParsedArchive,
        manifest: ParsedBundleManifest,
        tempDir: File,
        bundleStoreDir: File,
        tmpDir: File,
        bundleId: String,
        progressCallback: (UpdateProgressPayload) -> Unit,
    ): MutableList<DiffProgressFileSnapshot>? {
        val archiveScratch = File(tempDir, "archive")
        val archiveFile = File(archiveScratch, "bundle.tar.br")
        val extractedDir = File(bundleStoreDir, "$bundleId.archive.tmp")
        val localBackupDir = File(bundleStoreDir, "$bundleId.local.tmp")
        archiveScratch.deleteRecursively()
        extractedDir.deleteRecursively()
        localBackupDir.deleteRecursively()
        archiveScratch.mkdirs()

        val progressFiles =
            mutableListOf(
                DiffProgressFileSnapshot(
                    path = "bundle.tar.br",
                    downloadPath = "bundle.tar.br",
                    status = "pending",
                    progress = 0.0,
                    order = 0,
                ),
            )
        emitDiffProgress(progressCallback, "downloading", progressFiles)

        return try {
            when (
                val result =
                    downloadService.downloadFileOnce(
                        URL(archiveUrl),
                        archiveFile,
                    ) { progress ->
                        updateDiffProgressFile(
                            files = progressFiles,
                            assetPath = "bundle.tar.br",
                            status = "downloading",
                            progress = progress.progress,
                            downloadPath = "bundle.tar.br",
                            downloadedBytes = progress.downloadedBytes,
                            totalBytes = progress.totalBytes,
                        )
                        emitDiffProgress(progressCallback, "downloading", progressFiles)
                    }
            ) {
                is DownloadResult.Error -> throw result.exception
                is DownloadResult.Success -> Unit
            }

            if (archiveFile.length() != archive.downloadByteSize) {
                throw IllegalStateException("Archive compressed size mismatch")
            }
            if (!HashUtils.verifyHash(archiveFile, archive.downloadFileHash)) {
                throw IllegalStateException("Archive compressed hash mismatch")
            }

            TarBrArchiveExtractor.extract(
                archiveFile = archiveFile,
                destination = extractedDir,
                expectedTarByteSize = archive.tarByteSize,
                expectedFiles = manifest.assets.mapValues { it.value.byteSize!! },
            )
            manifest.assets.forEach { (assetPath, expectedAsset) ->
                val extractedFile =
                    RelativePathResolver.resolveInside(extractedDir, assetPath)
                        ?: throw IllegalStateException("Archive output path is invalid")
                verifyManifestAssetFileOrThrow(
                    extractedFile,
                    expectedAsset,
                    hashMismatch = UpdateFailure.install(UpdateFailureReason.EXTRACT),
                )
            }

            if (!tmpDir.renameTo(localBackupDir)) {
                throw IllegalStateException("Cannot preserve locally prepared staging directory")
            }
            if (!extractedDir.renameTo(tmpDir)) {
                check(localBackupDir.renameTo(tmpDir)) { "Cannot restore locally prepared staging directory" }
                throw IllegalStateException("Cannot promote verified archive extraction")
            }
            localBackupDir.deleteRecursively()

            updateDiffProgressFile(
                files = progressFiles,
                assetPath = "bundle.tar.br",
                status = "downloaded",
                progress = 1.0,
                downloadedBytes = archive.downloadByteSize,
                totalBytes = archive.downloadByteSize,
            )
            emitDiffProgress(progressCallback, "finalizing", progressFiles)
            progressFiles
        } catch (error: Exception) {
            Log.w(TAG, "Archive optimization failed; using individual files: ${error.message}")
            val canUseIndividualPlan =
                tmpDir.exists() ||
                    (localBackupDir.exists() && localBackupDir.renameTo(tmpDir))
            if (!canUseIndividualPlan) {
                // Only the staging directory swap can leave tmpDir missing.
                throw HotUpdaterException.unexpected(error, UpdateFailure.install(UpdateFailureReason.STORAGE))
            }
            extractedDir.deleteRecursively()
            null
        } finally {
            archiveScratch.deleteRecursively()
            extractedDir.deleteRecursively()
            if (tmpDir.exists()) localBackupDir.deleteRecursively()
        }
    }

    private suspend fun updateBundleFromManifest(
        bundleId: String,
        manifestUrl: String,
        manifestFileHash: String,
        changedAssets: Map<String, ChangedAssetDescriptor>,
        archiveUrl: String?,
        fileResolver: ArtifactFileResolver?,
        selection: PersistedSelection?,
        bundleStoreDir: File,
        finalBundleDir: File,
        progressCallback: (UpdateProgressPayload) -> Unit,
    ): UpdateBundleResult {
        val activeBundleDir = getActiveBundleDir()
        val currentBundleId = getBundleId()
        val baseDir =
            fileSystem.getInternalFilesDir() ?: bundleStoreDir.parentFile ?: bundleStoreDir
        val tempDir = File(baseDir, "bundle-manifest-temp")
        val tmpDir = File(bundleStoreDir, "$bundleId.tmp")

        if (tempDir.exists()) {
            tempDir.deleteRecursively()
        }
        tempDir.mkdirs()

        var diffFiles = mutableListOf<DiffProgressFileSnapshot>()

        try {
            val manifestFile = File(tempDir, "manifest.json")
            val targetManifest =
                updateStep(UpdateFailureStage.DOWNLOAD, UpdateFailureResource.MANIFEST) {
                    emitDiffProgress(
                        progressCallback = progressCallback,
                        phase = "manifest",
                        files = diffFiles,
                        manifestProgress = 0.0,
                    )
                    when (
                        val manifestDownloadResult =
                            downloadService.downloadFile(
                                URL(manifestUrl),
                                manifestFile,
                            ) { downloadProgress ->
                                emitDiffProgress(
                                    progressCallback = progressCallback,
                                    phase = "manifest",
                                    files = diffFiles,
                                    manifestProgress = downloadProgress.progress,
                                )
                            }
                    ) {
                        is DownloadResult.Error -> {
                            throw downloadError(manifestDownloadResult.exception)
                        }

                        is DownloadResult.Success -> {
                            Unit
                        }
                    }

                    try {
                        SignatureVerifier.verifyBundle(publicKeyProvider(), manifestFile, manifestFileHash)
                    } catch (e: SignatureVerificationException) {
                        throw HotUpdaterException.signatureVerificationFailed(e)
                    }

                    val manifest = parseBundleManifestFromFile(manifestFile) ?: throw HotUpdaterException.invalidBundle()
                    if (manifest.bundleId != bundleId) {
                        throw HotUpdaterException.invalidBundle()
                    }
                    if (fileResolver == null) {
                        // Legacy: artifact protocol v1, where every file comes with its URL.
                        // Reuse never bypasses the complete artifact contract.
                        if (manifest.assets.keys != changedAssets.keys) throw HotUpdaterException.invalidBundle()
                    } else if (!manifest.assets.keys.containsAll(changedAssets.keys)) {
                        // In v2, `assets` holds only the Hermes patch.
                        throw HotUpdaterException.invalidBundle()
                    }
                    manifest.assets.forEach { (path, asset) ->
                        val descriptor = changedAssets[path]
                        if (RelativePathResolver.normalizeRelativePath(path) != path ||
                            path == "manifest.json" ||
                            (fileResolver == null && descriptor?.fileUrl.isNullOrBlank()) ||
                            (fileResolver == null && !descriptor!!.fileHash.equals(asset.fileHash, ignoreCase = true)) ||
                            RelativePathResolver.resolveInside(tmpDir, path) == null
                        ) {
                            throw HotUpdaterException.invalidBundle()
                        }
                    }
                    manifest
                }
            // In v2, the manifest names every file; URLs come once the install
            // knows which files it downloads.
            val plannedAssets =
                if (fileResolver == null) {
                    changedAssets
                } else {
                    targetManifest.assets.mapValues { (path, asset) ->
                        ChangedAssetDescriptor(
                            fileUrl = null,
                            fileHash = asset.fileHash,
                            patch = changedAssets[path]?.patch,
                        )
                    }
                }
            updateStep(UpdateFailureStage.INSTALL, resource = null) {
                if (!tmpDir.isDirectory && !tmpDir.mkdirs()) throw HotUpdaterException.directoryCreationFailed()
                pruneStagingDirectory(tmpDir, targetManifest.assets.keys)
            }
            val downloads =
                updateStep(UpdateFailureStage.INSTALL, UpdateFailureResource.FILE) {
                    val targetEntries = targetManifest.assets.entries.sortedBy { it.key }
                    val localDirectories = listOfNotNull(activeBundleDir, finalBundleDir).distinct().filter { it.isDirectory }
                    val downloads = mutableMapOf<String, ChangedAssetDescriptor>()
                    targetEntries.forEachIndexed { index, (assetPath, expectedAsset) ->
                        progressCallback(
                            UpdateProgressPayload(
                                progress = 0.15 + 0.05 * index / targetEntries.size.coerceAtLeast(1),
                                artifactType = "diff",
                                details = DiffProgressDetails(totalFilesCount = 0, completedFilesCount = 0),
                            ),
                        )
                        val targetFile = RelativePathResolver.resolveInside(tmpDir, assetPath) ?: throw HotUpdaterException.invalidBundle()
                        targetFile.parentFile?.mkdirs()
                        if (targetFile.isFile && runCatching { verifyManifestAssetFileOrThrow(targetFile, expectedAsset) }.isSuccess) {
                            return@forEachIndexed
                        }
                        if (targetFile.exists()) targetFile.delete()
                        var reused = false
                        for (directory in localDirectories) {
                            val sourceFile = RelativePathResolver.resolveInside(directory, assetPath) ?: continue
                            val sourceMatches =
                                sourceFile.isFile && runCatching { verifyManifestAssetFileOrThrow(sourceFile, expectedAsset) }.isSuccess
                            if (!sourceMatches) continue
                            if (runCatching {
                                    copyBundleFile(sourceFile, targetFile)
                                    verifyManifestAssetFileOrThrow(targetFile, expectedAsset)
                                }.isSuccess
                            ) {
                                reused = true
                                break
                            }
                            targetFile.delete()
                        }
                        if (reused) return@forEachIndexed
                        if (builtInAssetResolver.copyIfMatches(assetPath, expectedAsset.fileHash, targetFile)) {
                            verifyManifestAssetFileOrThrow(targetFile, expectedAsset)
                            return@forEachIndexed
                        }
                        val packagedHash = builtInAssetResolver.copyIfSourceMatches(assetPath, expectedAsset.fileHash, targetFile)
                        if (packagedHash != null && isBuiltInEquivalent(assetPath, targetFile, expectedAsset)) {
                            return@forEachIndexed
                        }
                        if (packagedHash != null) targetFile.delete()
                        downloads[assetPath] = plannedAssets.getValue(assetPath)
                    }
                    downloads
                }
            val builtInPatchBases =
                updateStep(UpdateFailureStage.INSTALL, UpdateFailureResource.FILE) {
                    prepareBuiltInPatchBases(downloads, currentBundleId, tempDir)
                }
            val selectedArchive = selectArchive(targetManifest, downloads, archiveUrl, currentBundleId, builtInPatchBases)
            val archiveProgress =
                if (selectedArchive != null) {
                    updateStep(UpdateFailureStage.DOWNLOAD, UpdateFailureResource.ARCHIVE) {
                        tryInstallArchive(
                            archiveUrl = archiveUrl!!,
                            archive = selectedArchive,
                            manifest = targetManifest,
                            tempDir = tempDir,
                            bundleStoreDir = bundleStoreDir,
                            tmpDir = tmpDir,
                            bundleId = bundleId,
                            progressCallback = progressCallback,
                        )
                    }
                } else {
                    null
                }

            val fileDeliveries =
                if (archiveProgress != null) {
                    diffFiles = archiveProgress
                    emptyList()
                } else {
                    if (fileResolver != null) {
                        updateStep(UpdateFailureStage.DOWNLOAD, UpdateFailureResource.FILE) {
                            resolveFileUrls(fileResolver, downloads)
                        }
                    }
                    diffFiles = createDiffProgressFiles(downloads)
                    emitDiffProgress(progressCallback, "downloading", diffFiles)
                    val progressLock = Any()
                    coroutineScope {
                        val permits = Semaphore(PARALLEL_FILE_DOWNLOADS)
                        diffFiles
                            .toList()
                            .map { progressFile ->
                                async {
                                    permits.withPermit {
                                        updateStep(UpdateFailureStage.DOWNLOAD, UpdateFailureResource.FILE) {
                                            val path = progressFile.path
                                            val workerTemp =
                                                File(tempDir, progressFile.order.toString()).apply { mkdirs() }
                                            downloadManifestAsset(
                                                assetPath = path,
                                                expectedAsset = targetManifest.assets.getValue(path),
                                                changedAsset = downloads.getValue(path),
                                                currentBundleId = currentBundleId,
                                                activeBundleDir = activeBundleDir,
                                                builtInBaseFile = builtInPatchBases[path],
                                                targetFile =
                                                    RelativePathResolver.resolveInside(tmpDir, path)
                                                        ?: throw HotUpdaterException.invalidBundle(),
                                                tempDir = workerTemp,
                                                progressFile = progressFile,
                                                progressCallback = { payload ->
                                                    synchronized(progressLock) {
                                                        payload.details?.files?.firstOrNull()?.let { snapshot ->
                                                            val index = diffFiles.indexOfFirst { it.path == path }
                                                            diffFiles[index] = snapshot
                                                        }
                                                        emitDiffProgress(progressCallback, "downloading", diffFiles)
                                                    }
                                                },
                                            )
                                        }
                                    }
                                }
                            }.awaitAll()
                    }
                }

            updateStep(UpdateFailureStage.INSTALL, resource = null) {
                emitDiffProgress(
                    progressCallback = progressCallback,
                    phase = "finalizing",
                    files = diffFiles,
                )

                manifestFile.copyTo(File(tmpDir, "manifest.json"), overwrite = true)

                val extractedIndex = tmpDir.walk().find { it.name == "index.android.bundle" }
                if (extractedIndex == null) {
                    // The manifest lists no platform bundle.
                    throw HotUpdaterException.invalidBundle().withResource(UpdateFailureResource.MANIFEST)
                }

                val backupDir = installBackupDir(bundleId)
                val updatedMetadata =
                    synchronized(releaseStateLock) {
                        if (backupDir.exists()) {
                            throw HotUpdaterException.moveOperationFailed()
                        }

                        val hadExistingFinal = finalBundleDir.exists()
                        var promoted = false
                        val previousBundleUrl = preferences.getItem("HotUpdaterBundleURL")
                        try {
                            if (hadExistingFinal && !directoryRenamer(finalBundleDir, backupDir)) {
                                throw HotUpdaterException.moveOperationFailed()
                            }
                            if (!directoryRenamer(tmpDir, finalBundleDir)) {
                                if (hadExistingFinal) {
                                    directoryRenamer(backupDir, finalBundleDir)
                                }
                                throw HotUpdaterException.moveOperationFailed()
                            }
                            promoted = true

                            val finalIndexFile =
                                resolveBundleFile(finalBundleDir, bundleId)
                                    ?: throw HotUpdaterException.invalidBundle()
                            if (!isCompleteBundleDirectory(finalBundleDir, bundleId)) {
                                throw HotUpdaterException.invalidBundle()
                            }
                            finalBundleDir.setLastModified(System.currentTimeMillis())

                            val currentMetadata = loadMetadataOrNull() ?: createInitialMetadata()
                            val nextMetadata = prepareMetadataForNewStagingBundle(currentMetadata, bundleId, selection)
                            if (!setBundleURL(finalIndexFile.absolutePath)) {
                                throw HotUpdaterException.storageFailed("Failed to persist bundle URL")
                            }
                            if (!saveMetadata(nextMetadata)) {
                                throw HotUpdaterException.storageFailed("Failed to persist bundle metadata")
                            }

                            if (backupDir.exists() && !backupDir.deleteRecursively()) {
                                Log.w(TAG, "Failed to remove committed install backup: ${backupDir.absolutePath}")
                            }
                            nextMetadata
                        } catch (e: Exception) {
                            runCatching { preferences.setItem("HotUpdaterBundleURL", previousBundleUrl) }
                            clearActiveBundleMetadataSnapshot()
                            if (promoted && finalBundleDir.exists() && !finalBundleDir.deleteRecursively()) {
                                Log.e(TAG, "Failed to remove uncommitted bundle: ${finalBundleDir.absolutePath}")
                            }
                            if (hadExistingFinal &&
                                !finalBundleDir.exists() &&
                                backupDir.exists() &&
                                !directoryRenamer(backupDir, finalBundleDir)
                            ) {
                                Log.e(TAG, "Failed to restore install backup: ${backupDir.absolutePath}")
                            }
                            throw e
                        }
                    }

                tempDir.deleteRecursively()
                cleanupOldBundles(bundleStoreDir, updatedMetadata.stableBundleId, bundleId)
                progressCallback(
                    UpdateProgressPayload(
                        progress = 1.0,
                        artifactType = "diff",
                        details =
                            DiffProgressDetails(
                                totalFilesCount = diffFiles.size,
                                completedFilesCount = diffFiles.count { it.status == "downloaded" },
                                files = diffFiles.toList(),
                            ),
                    ),
                )
            }

            return UpdateBundleResult(
                delivery =
                    when {
                        archiveProgress != null -> BundleDelivery.ARCHIVE
                        FileDelivery.PATCHED in fileDeliveries -> BundleDelivery.PATCH
                        else -> BundleDelivery.MANIFEST
                    },
                patchFallback = FileDelivery.DOWNLOADED_AFTER_PATCH_FAILURE in fileDeliveries,
            )
        } catch (e: Exception) {
            tempDir.deleteRecursively()
            // A retry rehashes completed files and rejects partial bytes.
            throw classifyUpdateFailure(e, UpdateFailureStage.DOWNLOAD, resource = null)
        }
    }

    private fun cleanupOldBundles(
        bundleStoreDir: File,
        currentBundleId: String?,
        bundleId: String,
    ) {
        try {
            // List only directories that are not .tmp
            val bundles =
                bundleStoreDir
                    .listFiles { file ->
                        file.isDirectory &&
                            !file.name.endsWith(".tmp") &&
                            !file.name.endsWith(".install-backup")
                    }?.toList() ?: return

            // Keep only the specified bundle IDs (filter out null values)
            val bundleIdsToKeep = setOfNotNull(currentBundleId, bundleId).filter { it.isNotBlank() }

            bundles.forEach { bundle ->
                try {
                    if (bundle.name !in bundleIdsToKeep) {
                        Log.d(TAG, "Removing old bundle: ${bundle.name}")
                        if (bundle.deleteRecursively()) {
                            Log.d(TAG, "Successfully removed old bundle: ${bundle.name}")
                        } else {
                            Log.w(TAG, "Failed to remove old bundle: ${bundle.name}")
                        }
                    } else {
                        Log.d(TAG, "Keeping bundle: ${bundle.name}")
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error removing bundle ${bundle.name}: ${e.message}")
                }
            }

            // Remove any leftover .tmp directories
            bundleStoreDir
                .listFiles { file ->
                    file.isDirectory && file.name.endsWith(".tmp")
                }?.forEach { staleTmp ->
                    try {
                        Log.d(TAG, "Removing stale tmp directory: ${staleTmp.name}")
                        if (staleTmp.deleteRecursively()) {
                            Log.d(TAG, "Successfully removed tmp directory: ${staleTmp.name}")
                        } else {
                            Log.w(TAG, "Failed to remove tmp directory: ${staleTmp.name}")
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "Error removing tmp directory ${staleTmp.name}: ${e.message}")
                    }
                }
        } catch (e: Exception) {
            Log.e(TAG, "Error during cleanup: ${e.message}")
        }
    }

    /**
     * Gets the base URL for the current active bundle directory.
     * Returns the file:// URL to the bundle directory without trailing slash.
     * This is used for Expo DOM components to construct full asset paths.
     * @return Base URL string (e.g., "file:///data/.../bundle-store/abc123") or empty string
     */
    override fun getBaseURL(): String {
        return try {
            val activeBundleId = getActiveBundleId()

            if (activeBundleId != null) {
                val bundleDir = File(getBundleStoreDir(), activeBundleId)
                if (bundleDir.exists()) {
                    return "file://${bundleDir.absolutePath}"
                }
            }

            ""
        } catch (e: Exception) {
            Log.e(TAG, "Error getting base URL: ${e.message}")
            ""
        }
    }

    override fun getBaseURLForBundle(bundleId: String?): String {
        return try {
            val activeBundleId = bundleId?.takeIf { it.isNotBlank() } ?: return ""
            val bundleDir = File(getBundleStoreDir(), activeBundleId)
            if (!bundleDir.exists()) {
                return ""
            }

            "file://${bundleDir.absolutePath}"
        } catch (e: Exception) {
            Log.e(TAG, "Error getting base URL for bundle $bundleId: ${e.message}")
            ""
        }
    }

    override fun getBundleId(): String? =
        try {
            getActiveBundleMetadataSnapshot()?.bundleId
        } catch (e: Exception) {
            Log.e(TAG, "Error getting bundle ID: ${e.message}")
            null
        }

    override fun getManifest(): Map<String, Any?> =
        try {
            getActiveBundleMetadataSnapshot()?.manifest ?: emptyMap()
        } catch (e: Exception) {
            Log.e(TAG, "Error getting manifest: ${e.message}")
            emptyMap()
        }

    override fun getManifestForBundle(bundleId: String?): Map<String, Any?> =
        try {
            getBundleMetadataSnapshot(bundleId)?.manifest ?: emptyMap()
        } catch (e: Exception) {
            Log.e(TAG, "Error getting manifest for bundle $bundleId: ${e.message}")
            emptyMap()
        }

    override suspend fun resetChannel(): Boolean =
        withContext(Dispatchers.IO) {
            synchronized(releaseStateLock) { resetChannelLocked() }
        }

    override suspend fun resetChannelIfSelectionCurrent(
        catalogId: String,
        scopeKey: String,
        generation: Long,
        catalogHash: String,
        channel: String,
        selectionContextHash: String,
    ): Boolean =
        withContext(Dispatchers.IO) {
            // The catalog checks take the same reentrant monitor, so none
            // accepts a newer catalog between this check and the reset.
            synchronized(releaseStateLock) {
                isReleaseSelectionCurrent(
                    catalogId = catalogId,
                    scopeKey = scopeKey,
                    generation = generation,
                    catalogHash = catalogHash,
                    channel = channel,
                    selectionContextHash = selectionContextHash,
                ) &&
                    resetChannelLocked()
            }
        }

    private fun resetChannelLocked(): Boolean {
        if (!setBundleURL(null)) {
            return false
        }

        val clearedMetadata =
            (loadMetadataOrNull() ?: BundleMetadata()).copy(
                isolationKey = isolationKey,
                stableBundleId = null,
                stagingBundleId = null,
                stableSelection = null,
                stagingSelection = null,
                pendingUpdateStrategy = null,
                pendingTransition = null,
                verificationPending = false,
                launchInProgress = false,
                // Selections made before the reset no longer stage; the
                // high-water marks stay, so an older catalog is still refused.
                currentSelectionContexts = emptyMap(),
                updatedAt = System.currentTimeMillis(),
            )

        if (!saveMetadata(clearedMetadata)) {
            return false
        }

        saveLaunchReport(null)

        getBundleStoreDir().listFiles()?.forEach { file ->
            if (
                file.name == BundleMetadata.METADATA_FILENAME ||
                file.name == CrashedHistory.CRASHED_HISTORY_FILENAME ||
                file.name == LaunchReport.LAUNCH_REPORT_FILENAME
            ) {
                return@forEach
            }

            if (file.isDirectory) {
                file.deleteRecursively()
            }
        }

        return true
    }
}
