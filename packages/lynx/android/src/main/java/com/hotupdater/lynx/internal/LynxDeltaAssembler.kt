package com.hotupdater.lynx.internal

import android.util.Log
import com.hotupdater.lynx.LynxArtifactRequest
import com.hotupdater.lynx.VerifiedLynxInstallation
import com.hotupdater.lynx.vendor.brotli.dec.BrotliInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlin.coroutines.coroutineContext
import org.json.JSONObject

internal data class LynxPatchedAssetEvidence(
    val path: String,
    val patchFileHash: String,
    val reconstructedFileHash: String,
)

/** Builds a new manifest tree from a native-owned running installation. Never mutates the base. */
internal class LynxDeltaAssembler(private val integrity: ArchiveIntegrity, private val downloader: ArchiveDownload) {
    suspend fun assemble(
        transaction: File,
        payload: File,
        request: LynxArtifactRequest,
        base: VerifiedLynxInstallation,
        onDownload: (Long) -> Unit,
    ): List<LynxPatchedAssetEvidence> {
        require(request.hasDelta) { "Incomplete manifest delivery descriptor" }
        val operationContext = coroutineContext
        val scratch = File(transaction, "delta-downloads").also { check(it.mkdir()) }
        var downloaded = 0L
        val patchedAssets = mutableListOf<LynxPatchedAssetEvidence>()
        suspend fun download(
            url: String,
            destination: File,
            limit: Long = ArchiveLimits.MAX_FILE_BYTES,
            allowEmpty: Boolean = false,
        ) {
            var received = 0L
            downloader.download(
                url,
                destination,
                { bytes -> received = bytes; onDownload(downloaded + bytes) },
                limit,
                allowEmpty,
            )
            downloaded += received
        }
        try {
            val manifestFile = File(payload, "manifest.json")
            download(checkNotNull(request.manifestUrl), manifestFile, ArchiveLimits.MAX_METADATA_BYTES)
            integrity.verify(manifestFile, checkNotNull(request.manifestFileHash))
            val manifest = StrictJson.read(manifestFile)
            require(StrictJson.string(manifest, "bundleId") == request.bundleId) { "Manifest Bundle identity mismatch" }
            val assets = manifest.optJSONObject("assets") ?: error("Invalid manifest assets")
            require(assets.length() >= 1) { "Invalid manifest asset count" }
            val paths = assets.keys().asSequence().toSet()
            val targetNamespace = ManagedPathNamespace()
            targetNamespace.file("manifest.json")
            paths.forEach(targetNamespace::file)
            val targetHashes = mutableMapOf<String, String>()
            val targetSignatures = mutableMapOf<String, String?>()
            for (path in paths) {
                val asset = assets.optJSONObject(path) ?: error("Invalid target asset")
                val hash = StrictJson.string(asset, "fileHash")
                require(hash.matches(HASH)) { "Invalid target asset hash" }
                targetHashes[path] = hash
                targetSignatures[path] = asset.opt("signature").let {
                    if (it == null || it == JSONObject.NULL) null
                    else it as? String ?: error("Invalid asset signature")
                }
            }
            val changes = checkNotNull(request.changedAssets)
            val baseManifestFile = ManagedPaths.resolve(base.directory, "manifest.json")
            verifyHash(baseManifestFile, base.manifestHash)
            val baseManifest = StrictJson.read(baseManifestFile)
            require(StrictJson.string(baseManifest, "bundleId") == base.bundleId) { "Native base manifest identity changed" }
            val baseAssets = baseManifest.getJSONObject("assets")
            val basePaths = baseAssets.keys().asSequence().toSet()
            val baseNamespace = ManagedPathNamespace()
            baseNamespace.file("manifest.json")
            basePaths.forEach(baseNamespace::file)
            require(basePaths == base.managedPaths) { "Native base manifest paths changed" }
            val baseHashes = basePaths.associateWith { path ->
                val hash = StrictJson.string(
                    baseAssets.optJSONObject(path) ?: error("Invalid base asset"),
                    "fileHash",
                )
                require(hash.matches(HASH)) { "Invalid base asset hash" }
                require(base.managedFileHashes[path].equals(hash, ignoreCase = true)) {
                    "Native base manifest hashes changed"
                }
                hash
            }
            val requiredChanges = paths.filterTo(mutableSetOf()) { path ->
                !baseHashes[path].equals(targetHashes.getValue(path), ignoreCase = true)
            }
            require(changes.keys == requiredChanges) {
                "Changed asset descriptors do not exactly match target changes"
            }
            var assembled = manifestFile.length()
            for (path in paths) {
                operationContext.ensureActive()
                val expectedHash = targetHashes.getValue(path)
                val signature = targetSignatures[path]
                val target = ManagedPaths.resolve(payload, path)
                check(target.parentFile!!.mkdirs() || target.parentFile!!.isDirectory) { "Cannot create managed asset directory" }
                val source = if (path in base.managedPaths) ManagedPaths.resolve(base.directory, path) else null
                val baseHash = baseHashes[path]
                if (source != null && baseHash.equals(expectedHash, ignoreCase = true)) {
                    verifyHash(source, expectedHash)
                    source.inputStream().use { input -> copyBounded(input, target, ArchiveLimits.MAX_EXTRACTED_BYTES - assembled) { operationContext.ensureActive() } }
                } else {
                    val changed = checkNotNull(changes[path]) { "Missing changed asset: $path" }
                    require(changed.fileHash.equals(expectedHash, ignoreCase = true)) { "Changed asset hash differs from target manifest" }
                    var patched = false
                    changed.patch?.let { patch ->
                        try {
                            require(patch.algorithm == "bsdiff") { "Unsupported patch algorithm" }
                            require(patch.baseBundleId == base.bundleId && source != null && baseHash.equals(patch.baseFileHash, ignoreCase = true)) { "Patch base does not match the native running Bundle" }
                            verifyHash(source, patch.baseFileHash)
                            val patchFile = File(scratch, "patch")
                            download(patch.patchUrl, patchFile)
                            verifyHash(patchFile, patch.patchFileHash)
                            val observedPatchHash = HashUtils.calculateSHA256(patchFile)
                            BsdiffPatch.apply(source, patchFile, target) { operationContext.ensureActive() }
                            require(target.length() <= ArchiveLimits.MAX_EXTRACTED_BYTES - assembled) { "Assembled artifact exceeds size limit" }
                            integrity.verifyAsset(target, expectedHash, signature)
                            val reconstructedHash = HashUtils.calculateSHA256(target)
                            patched = true
                            patchedAssets.add(
                                LynxPatchedAssetEvidence(
                                    path,
                                    observedPatchHash,
                                    reconstructedHash,
                                ),
                            )
                        } catch (error: CancellationException) { throw error }
                        catch (error: Exception) {
                            operationContext.ensureActive()
                            target.delete()
                            Log.i(
                                TAG,
                                "HotUpdaterBsdiffPatchFallback bundleId=${request.bundleId} baseBundleId=${patch.baseBundleId} asset=$path",
                            )
                        } finally { File(scratch, "patch").delete() }
                    }
                    if (!patched) {
                        val file = checkNotNull(changed.file) { "Patch failed and changed asset has no full-file fallback: $path" }
                        require(file.compression == null || file.compression == "br") { "Unsupported changed asset compression" }
                        val downloadFile = File(scratch, "file")
                        try {
                            download(
                                file.url,
                                downloadFile,
                                allowEmpty = file.compression == null,
                            )
                            val input: InputStream = if (file.compression == "br") BrotliInputStream(downloadFile.inputStream()) else downloadFile.inputStream()
                            input.use { copyBounded(it, target, ArchiveLimits.MAX_EXTRACTED_BYTES - assembled) { operationContext.ensureActive() } }
                        } finally { downloadFile.delete() }
                    }
                }
                integrity.verifyAsset(target, expectedHash, signature)
                assembled += target.length()
                require(assembled <= ArchiveLimits.MAX_EXTRACTED_BYTES) { "Assembled artifact exceeds size limit" }
            }
            return patchedAssets
        } finally { scratch.deleteRecursively() }
    }

    private fun copyBounded(input: InputStream, target: File, remaining: Long, checkCancelled: () -> Unit) {
        var count = 0L
        FileOutputStream(target).use { output ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                checkCancelled()
                val size = input.read(buffer)
                if (size < 0) break
                count += size
                require(count <= minOf(ArchiveLimits.MAX_FILE_BYTES, remaining)) { "Managed asset exceeds size limit" }
                output.write(buffer, 0, size)
            }
            output.fd.sync()
        }
    }

    private fun verifyHash(file: File, hash: String) {
        require(file.isFile && file.length() <= ArchiveLimits.MAX_FILE_BYTES && hash.matches(Regex("[0-9a-fA-F]{64}"))) { "Invalid delta source or hash" }
        require(HashUtils.calculateSHA256(file).equals(hash, ignoreCase = true)) { "Delta source hash mismatch" }
    }

    companion object {
        private const val TAG = "HotUpdaterLynx"
        private val HASH = Regex("[0-9a-fA-F]{64}")
    }
}
