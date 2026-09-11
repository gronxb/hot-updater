package com.hotupdater.lynx

import android.system.Os
import android.system.OsConstants
import com.hotupdater.lynx.internal.ArchiveDownload
import com.hotupdater.lynx.internal.ArchiveIntegrity
import com.hotupdater.lynx.internal.ArchiveLimits
import com.hotupdater.lynx.internal.DurableFiles
import com.hotupdater.lynx.internal.LynxArtifactVerifier
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
import kotlin.coroutines.coroutineContext

internal class PreparationLease(val file: RandomAccessFile, val lock: FileLock) {
    private val closed = AtomicBoolean()
    fun close() { if (closed.compareAndSet(false, true)) { try { lock.release() } finally { file.close() } } }
}

/** Request and verified files are retained natively; JS receives a controller-owned opaque ID. */
class PreparedLynxArtifact internal constructor(
    internal val owner: String,
    internal val transaction: File,
    internal val request: LynxArtifactRequest,
    internal val manifestHash: String,
    internal val lease: PreparationLease,
) {
    val bundleId: String get() = request.bundleId
    internal var consumed = false
}

/** Prepares immutable artifacts. It never changes running or next-selection state. */
class LynxArtifactInstaller(storageDirectory: File, config: LynxInstallConfiguration) {
    private val root = storageDirectory.canonicalFile
    private val owner = UUID.randomUUID().toString()
    private val integrity = ArchiveIntegrity(config.publicKeyPem)
    private val verifier = LynxArtifactVerifier(config, integrity)
    private val downloader = ArchiveDownload()
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

    suspend fun prepare(request: LynxArtifactRequest, onDownload: (Long) -> Unit = {}): PreparedLynxArtifact {
        var ownedTransaction: File? = null
        var ownedLease: PreparationLease? = null
        try {
            return withContext(Dispatchers.IO) {
                require(request.bundleId.matches(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))) { "Invalid Bundle ID" }
                val transaction = locked {
                    File(transactions, UUID.randomUUID().toString()).also { directory ->
                        check(directory.mkdir()) { "Cannot create private preparation" }
                        ownedTransaction = directory
                        val leaseFile = RandomAccessFile(File(directory, "lease"), "rw")
                        ownedLease = PreparationLease(leaseFile, leaseFile.channel.lock())
                        FileOutputStream(File(directory, "bundleId")).use { output -> output.write(request.bundleId.toByteArray()); output.fd.sync() }
                    }
                }
                val archive = File(transaction, "archive")
                val cachedArchive = File(File(installations, request.bundleId), "archive")
                if (cachedArchive.isFile) {
                    require(cachedArchive.length() in 1..ArchiveLimits.MAX_ARCHIVE_BYTES) { "Invalid cached archive size" }
                    cachedArchive.inputStream().use { input -> FileOutputStream(archive).use { output -> input.copyTo(output); output.fd.sync() } }
                } else downloader.download(request.fileUrl, archive, onDownload)
                coroutineContext.ensureActive()
                integrity.verify(archive, request.fileHash)
                val payload = File(transaction, "payload").also { check(it.mkdir()) }
                StrictArchive.extract(archive, payload)
                coroutineContext.ensureActive()
                val verified = verifier.verify(payload, request)
                coroutineContext.ensureActive()
                PreparedLynxArtifact(owner, transaction, request.copy(), verified.manifestHash, checkNotNull(ownedLease))
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
                integrity.verify(File(prepared.transaction, "archive"), prepared.request.fileHash)
                val verified = verifier.verify(File(prepared.transaction, "payload"), prepared.request)
                check(verified.manifestHash == prepared.manifestHash) { "Prepared metadata changed" }
                operationContext.ensureActive()
                val result = withCurrentAuthorization {
                    operationContext.ensureActive()
                    check(active && published == null && !prepared.consumed) { "Publication must run once inside authorization" }
                    val destination = File(installations, prepared.request.bundleId)
                    if (destination.exists()) {
                        integrity.verify(File(destination, "archive"), prepared.request.fileHash)
                        val existing = verifier.verify(File(destination, "payload"), prepared.request)
                        check(existing.manifestHash == prepared.manifestHash) { "Immutable Bundle identity conflict" }
                    } else {
                        syncDirectories(prepared.transaction)
                        operationContext.ensureActive()
                        check(prepared.transaction.renameTo(destination)) { "Atomic installation publication failed" }
                        syncDirectory(installations)
                        syncDirectory(transactions)
                    }
                    prepared.consumed = true
                    verifier.verify(File(destination, "payload"), prepared.request).also { published = it }
                }
                check(result === published) { "Authorization did not publish this preparation" }
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

    /** Keep every native/context/preparation lease plus at most two unused cached bundles. */
    internal fun prune(withProtectedState: (removeUnused: (Set<String>) -> Set<String>) -> Unit) = locked {
        withProtectedState { protected ->
            val preparing = transactions.listFiles().orEmpty().mapNotNull { directory ->
                File(directory, "bundleId").takeIf { it.isFile }?.readText()
            }.toSet()
            val unused = installations.listFiles().orEmpty().filter { it.isDirectory && it.name !in protected && it.name !in preparing }
                .sortedByDescending { it.lastModified() }
            unused.drop(2).forEach { check(it.deleteRecursively()) { "Cannot remove unused cached installation" } }
            syncDirectory(installations)
            installations.listFiles().orEmpty().filter { it.isDirectory }.map { it.name }.toSet()
        }
    }

    private fun <T> locked(block: () -> T): T = synchronized(locks.getOrPut(root.path) { Any() }) {
        RandomAccessFile(File(root, "installation.lock"), "rw").use { file -> file.channel.lock().use { block() } }
    }
    private fun syncDirectories(directory: File) { directory.walkBottomUp().filter { it.isDirectory }.forEach(::syncDirectory) }
    private fun syncDirectory(directory: File) {
        val descriptor = Os.open(directory.path, OsConstants.O_RDONLY, 0)
        try { Os.fsync(descriptor) } finally { Os.close(descriptor) }
    }
    companion object { private val locks = ConcurrentHashMap<String, Any>() }
}
