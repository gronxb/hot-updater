package com.hotupdater.lynx

import android.util.Log
import com.hotupdater.lynx.internal.ArchiveDownload
import com.hotupdater.lynx.internal.ArchiveIntegrity
import com.hotupdater.lynx.internal.ArchiveLimits
import com.hotupdater.lynx.internal.DurableFiles
import com.hotupdater.lynx.internal.LynxArtifactVerifier
import com.hotupdater.lynx.internal.LynxDeltaAssembler
import com.hotupdater.lynx.internal.LynxPatchedAssetEvidence
import com.hotupdater.lynx.internal.StrictArchive
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.channels.FileLock
import java.nio.channels.OverlappingFileLockException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONObject
import kotlin.coroutines.coroutineContext

internal class PreparationLease(val file: RandomAccessFile, val lock: FileLock) {
    private val closed = AtomicBoolean()
    fun close() { if (closed.compareAndSet(false, true)) { try { lock.release() } finally { file.close() } } }
}

internal class InstallationLease private constructor(
    private val path: String?,
) {
    private val closed = AtomicBoolean()

    fun close() {
        val retainedPath = path ?: return
        if (!closed.compareAndSet(false, true)) return
        synchronized(entries) {
            val entry = checkNotNull(entries[retainedPath])
            entry.references -= 1
            if (entry.references == 0) {
                entries.remove(retainedPath)
                try {
                    entry.lock.release()
                } finally {
                    entry.file.close()
                }
            }
        }
    }

    private class Entry(
        val file: RandomAccessFile,
        val lock: FileLock,
        var references: Int,
    )

    companion object {
        private val entries = mutableMapOf<String, Entry>()
        val none = InstallationLease(null)

        fun acquire(directory: File): InstallationLease {
            val path = directory.canonicalPath
            synchronized(entries) {
                entries[path]?.let {
                    it.references += 1
                    return InstallationLease(path)
                }
                val file = RandomAccessFile(File(directory, "resource.lease"), "rw")
                try {
                    val lock = file.channel.lock(0L, Long.MAX_VALUE, true)
                    entries[path] = Entry(file, lock, 1)
                } catch (error: Throwable) {
                    file.close()
                    throw error
                }
                return InstallationLease(path)
            }
        }
    }
}

/** Request and verified files are retained natively; JS receives a controller-owned opaque ID. */
class PreparedLynxArtifact internal constructor(
    internal val owner: String,
    internal val transactionId: String,
    internal val transaction: File,
    internal val request: LynxArtifactRequest,
    internal val releaseId: String?,
    internal val manifestHash: String,
    internal val manifestBacked: Boolean,
    internal val baseBundleId: String?,
    internal val patchedAssets: List<LynxPatchedAssetEvidence>,
    internal val archiveFallback: Boolean,
    internal val lease: PreparationLease,
) {
    val bundleId: String get() = request.bundleId
    internal var consumed = false
}

/** Prepares immutable artifacts. It never changes running or next-selection state. */
class LynxArtifactInstaller internal constructor(
    storageDirectory: File,
    config: LynxInstallConfiguration,
    private val directorySync: (File) -> Unit,
) {
    constructor(storageDirectory: File, config: LynxInstallConfiguration) : this(
        storageDirectory,
        config,
        DurableFiles::syncDirectory,
    )
    private val root = storageDirectory.canonicalFile
    private val owner = UUID.randomUUID().toString()
    private val integrity = ArchiveIntegrity(config.publicKeyPem)
    private val verifier = LynxArtifactVerifier(config, integrity)
    private val downloader = ArchiveDownload()
    private val deltaAssembler = LynxDeltaAssembler(integrity, downloader)
    private val transactions = File(root, "preparations")
    private val installations = File(root, "installations")

    init {
        DurableFiles.directory(transactions)
        DurableFiles.directory(installations)
        locked {
            // A process death releases its lease. Live preparations, including those from
            // another installer/process, remain protected until their owner releases them.
            transactions.listFiles().orEmpty().filter { it.isDirectory }.forEach { directory ->
                RandomAccessFile(File(directory, "lease"), "rw").use { file ->
                    val lease = try { file.channel.tryLock() } catch (_: OverlappingFileLockException) { null }
                    lease?.use { directory.deleteRecursively() }
                }
            }
        }
    }

    suspend fun prepare(
        request: LynxArtifactRequest,
        base: VerifiedLynxInstallation? = null,
        onDownload: (Long) -> Unit = {},
        releaseId: String? = null,
    ): PreparedLynxArtifact {
        var ownedTransaction: File? = null
        var ownedLease: PreparationLease? = null
        try {
            return withContext(Dispatchers.IO) {
                request.validateForPreparation()
                val transaction = locked {
                    val transactionId = UUID.randomUUID().toString()
                    File(transactions, transactionId).also { directory ->
                        check(directory.mkdir()) { "Cannot create private preparation" }
                        ownedTransaction = directory
                        val leaseFile = RandomAccessFile(File(directory, "lease"), "rw")
                        ownedLease = PreparationLease(leaseFile, leaseFile.channel.lock())
                        FileOutputStream(File(directory, "bundleId")).use { output -> output.write(request.bundleId.toByteArray()); output.fd.sync() }
                    }
                }
                var manifestError: Exception? = null
                var verified: VerifiedLynxInstallation? = null
                var patchedAssets = emptyList<LynxPatchedAssetEvidence>()
                if (request.hasDelta && base != null) {
                    val payload = File(transaction, "payload").also { check(it.mkdir()) }
                    try {
                        patchedAssets = deltaAssembler.assemble(
                            transaction,
                            payload,
                            request,
                            base,
                            onDownload,
                        )
                        coroutineContext.ensureActive()
                        verified = verifier.verify(payload, request, manifestBacked = true)
                    } catch (error: kotlinx.coroutines.CancellationException) {
                        throw error
                    } catch (error: Exception) {
                        manifestError = error
                        check(payload.deleteRecursively()) {
                            "Cannot clean failed manifest preparation"
                        }
                    }
                }
                if (verified == null) {
                    if (!request.hasArchive) {
                        throw manifestError ?: IllegalArgumentException(
                            "Full archive required without a usable native delta base",
                        )
                    }
                    val archive = File(transaction, "archive")
                    val cachedArchive = File(File(installations, request.bundleId), "archive")
                    if (cachedArchive.isFile) {
                        require(cachedArchive.length() in 1..ArchiveLimits.MAX_ARCHIVE_BYTES) {
                            "Invalid cached archive size"
                        }
                        cachedArchive.inputStream().use { input ->
                            FileOutputStream(archive).use { output ->
                                input.copyTo(output)
                                output.fd.sync()
                            }
                        }
                    } else {
                        downloader.download(checkNotNull(request.fileUrl), archive, onDownload)
                    }
                    coroutineContext.ensureActive()
                    integrity.verify(archive, checkNotNull(request.fileHash))
                    val payload = File(transaction, "payload").also { check(it.mkdir()) }
                    StrictArchive.extract(archive, payload)
                    coroutineContext.ensureActive()
                    verified = verifier.verify(payload, request)
                }
                coroutineContext.ensureActive()
                PreparedLynxArtifact(
                    owner,
                    transaction.name,
                    transaction,
                    request.copy(),
                    releaseId,
                    checkNotNull(verified).manifestHash,
                    verified.manifestBacked,
                    base?.bundleId,
                    patchedAssets,
                    manifestError != null && !verified.manifestBacked,
                    checkNotNull(ownedLease),
                )
            }
        } catch (error: Throwable) {
            // This also owns cleanup if prompt cancellation discards the verified result
            // while withContext is dispatching it back to its caller.
            withContext(NonCancellable + Dispatchers.IO) {
                locked { ownedLease?.close(); ownedTransaction?.deleteRecursively() }
            }
            throw error
        }
    }

    /**
     * Hold the native catalog/state lock across current authorization and publish().
     * Publish selection state only after publish succeeds. A failed state write may leave
     * reusable immutable bytes; it never implicitly activates the candidate.
     */
    suspend fun commitPrepared(
        prepared: PreparedLynxArtifact,
        withCurrentAuthorization: (publish: () -> VerifiedLynxInstallation) -> VerifiedLynxInstallation,
    ): VerifiedLynxInstallation = withContext(Dispatchers.IO) {
        val operationContext = coroutineContext
        locked {
            check(prepared.owner == owner && !prepared.consumed) { "Unknown or consumed preparation" }
            var published: VerifiedLynxInstallation? = null
            var active = true
            try {
                operationContext.ensureActive()
                val verified = verifyPrepared(prepared.transaction, prepared)
                check(verified.manifestHash == prepared.manifestHash) { "Prepared metadata changed" }
                operationContext.ensureActive()
                val result = withCurrentAuthorization {
                    operationContext.ensureActive()
                    check(active && published == null && !prepared.consumed) { "Publication must run once inside authorization" }
                    val destination = File(installations, prepared.request.bundleId)
                    if (destination.exists()) {
                        val existing = verifyPrepared(destination, prepared)
                        check(existing.manifestHash == prepared.manifestHash) { "Immutable Bundle identity conflict" }
                    } else {
                        syncDirectories(prepared.transaction)
                        operationContext.ensureActive()
                        check(prepared.transaction.renameTo(destination)) { "Atomic installation publication failed" }
                        try {
                            syncDirectory(installations)
                            syncDirectory(transactions)
                        } catch (error: Throwable) {
                            try {
                                check(destination.renameTo(prepared.transaction)) {
                                    "Could not roll back undurable installation publication"
                                }
                                syncDirectory(installations)
                                syncDirectory(transactions)
                            } catch (rollbackError: Throwable) {
                                error.addSuppressed(rollbackError)
                            }
                            throw error
                        }
                    }
                    prepared.consumed = true
                    verifyPrepared(destination, prepared).also { published = it }
                }
                check(result === published) { "Authorization did not publish this preparation" }
                logPublished(prepared)
                result
            } finally {
                active = false
                prepared.consumed = true
                prepared.lease.close()
                prepared.transaction.deleteRecursively()
            }
        }
    }

    fun discard(prepared: PreparedLynxArtifact) = locked {
        check(prepared.owner == owner) { "Unknown preparation" }
        if (!prepared.consumed) {
            prepared.consumed = true
            prepared.lease.close()
            prepared.transaction.deleteRecursively()
        }
    }

    internal fun retain(installation: VerifiedLynxInstallation): InstallationLease {
        val installationDirectory = checkNotNull(
            installation.directory.parentFile,
        ).canonicalFile
        if (installationDirectory.parentFile?.canonicalFile != installations) {
            return InstallationLease.none
        }
        return locked {
            check(installationDirectory.name == installation.bundleId) {
                "Installation lease Bundle identity mismatch"
            }
            check(
                installationDirectory.isDirectory &&
                    installation.directory.canonicalFile ==
                    File(installationDirectory, "payload").canonicalFile &&
                    installation.directory.isDirectory,
            ) { "Installation disappeared before resource retention" }
            InstallationLease.acquire(installationDirectory)
        }
    }

    /** Keep every native/context/preparation lease plus at most two unused cached bundles. */
    internal fun prune(withProtectedState: (removeUnused: (Set<String>) -> Set<String>) -> Unit) = locked {
        withProtectedState { protected ->
            val preparing = transactions.listFiles().orEmpty().mapNotNull { directory ->
                File(directory, "bundleId").takeIf { it.isFile }?.readText()
            }.toSet()
            val unused = installations.listFiles().orEmpty().filter {
                it.isDirectory && it.name !in protected && it.name !in preparing &&
                    !isRetained(it)
            }
                .sortedByDescending { it.lastModified() }
            unused.drop(2).forEach { check(it.deleteRecursively()) { "Cannot remove unused cached installation" } }
            syncDirectory(installations)
            installations.listFiles().orEmpty().filter { it.isDirectory }.map { it.name }.toSet()
        }
    }

    private fun <T> locked(block: () -> T): T = synchronized(locks.getOrPut(root.path) { Any() }) {
        RandomAccessFile(File(root, "installation.lock"), "rw").use { file -> file.channel.lock().use { block() } }
    }

    private fun isRetained(directory: File): Boolean {
        val leaseFile = File(directory, "resource.lease")
        if (!leaseFile.isFile) return false
        RandomAccessFile(leaseFile, "rw").use { file ->
            val lease = try {
                file.channel.tryLock()
            } catch (_: OverlappingFileLockException) {
                null
            }
            if (lease == null) return true
            lease.release()
            return false
        }
    }

    private fun verifyPrepared(
        directory: File,
        prepared: PreparedLynxArtifact,
    ): VerifiedLynxInstallation {
        if (prepared.manifestBacked) {
            require(!prepared.request.manifestFileHash.isNullOrBlank()) {
                "Manifest-backed installation lost its trust token"
            }
        } else {
            integrity.verify(
                File(directory, "archive"),
                checkNotNull(prepared.request.fileHash),
            )
        }
        return verifier.verify(
            File(directory, "payload"),
            prepared.request,
            prepared.manifestBacked,
        )
    }

    private fun logPublished(prepared: PreparedLynxArtifact) {
        if (prepared.manifestBacked) {
            val baseBundleId = checkNotNull(prepared.baseBundleId)
            prepared.patchedAssets.sortedBy { it.path }.forEach { asset ->
                val event = LynxInstallEvent.json(
                    "HotUpdaterBsdiffPatchApplied",
                    prepared,
                    baseBundleId,
                    asset,
                )
                Log.i(
                    TAG,
                    "HotUpdaterBsdiffPatchApplied bundleId=${prepared.bundleId} baseBundleId=$baseBundleId asset=${asset.path} HotUpdaterLynxEvent=$event",
                )
            }
            val event = LynxInstallEvent.json(
                "HotUpdaterManifestDiffApplied",
                prepared,
                baseBundleId,
            )
            Log.i(
                TAG,
                "HotUpdaterManifestDiffApplied bundleId=${prepared.bundleId} baseBundleId=$baseBundleId HotUpdaterLynxEvent=$event",
            )
        } else {
            if (prepared.archiveFallback) {
                Log.i(
                    TAG,
                    "HotUpdaterArchiveFallbackApplied bundleId=${prepared.bundleId} baseBundleId=${prepared.baseBundleId ?: "none"}",
                )
            }
            Log.i(TAG, "HotUpdaterArchiveInstalled bundleId=${prepared.bundleId}")
        }
    }

    private fun syncDirectories(directory: File) {
        directory.walkBottomUp().filter { it.isDirectory }.forEach(::syncDirectory)
    }

    private fun syncDirectory(directory: File) = directorySync(directory)

    companion object {
        private const val TAG = "HotUpdaterLynx"
        private val locks = ConcurrentHashMap<String, Any>()
    }
}

internal object LynxInstallEvent {
    fun json(
        event: String,
        prepared: PreparedLynxArtifact,
        baseBundleId: String,
        patchedAsset: LynxPatchedAssetEvidence? = null,
    ): String = JSONObject()
        .put("schemaVersion", 1)
        .put("event", event)
        .put("transactionId", prepared.transactionId)
        .put("bundleId", prepared.bundleId)
        .put("releaseId", prepared.releaseId ?: JSONObject.NULL)
        .put("baseBundleId", baseBundleId)
        .also { value ->
            patchedAsset?.let {
                value.put("asset", it.path)
                value.put("patchFileHash", it.patchFileHash)
                value.put("reconstructedFileHash", it.reconstructedFileHash)
            }
        }
        .toString()
}
