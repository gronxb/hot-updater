package com.hotupdater.lynx.internal

import com.hotupdater.lynx.LynxArtifactRequest
import com.hotupdater.lynx.LynxIncompatibleArtifactException
import com.hotupdater.lynx.LynxInstallConfiguration
import com.hotupdater.lynx.VerifiedLynxInstallation
import java.io.File
import java.math.BigDecimal

internal class LynxArtifactVerifier(private val config: LynxInstallConfiguration, private val integrity: ArchiveIntegrity) {
    /** Archive installations require an authenticated archive; delta installations authenticate their manifest here. */
    fun verify(root: File, request: LynxArtifactRequest, manifestBacked: Boolean = false): VerifiedLynxInstallation {
        val trustedRoot = root.canonicalFile
        require(trustedRoot.isDirectory) { "Installation root is not a directory" }
        val manifestFile = ManagedPaths.resolve(trustedRoot, "manifest.json")
        if (manifestBacked) require(!request.manifestFileHash.isNullOrBlank()) { "Delta installation requires authenticated manifest authority" }
        request.manifestFileHash?.let { integrity.verify(manifestFile, it) }
        val manifest = StrictJson.read(manifestFile)
        require(StrictJson.string(manifest, "bundleId") == request.bundleId) { "Manifest Bundle identity mismatch" }
        val assets = manifest.optJSONObject("assets") ?: error("Manifest assets must be an object")
        require(assets.length() >= 1) { "Invalid manifest asset count" }
        val paths = assets.keys().asSequence().toSet()
        val namespace = ManagedPathNamespace()
        namespace.file("manifest.json")
        paths.forEach(namespace::file)
        if ("hot-updater-lynx.json" !in paths) throw LynxIncompatibleArtifactException("Missing Lynx metadata")
        val fileHashes = mutableMapOf<String, String>()
        var totalBytes = manifestFile.length()
        for (path in paths) {
            val asset = assets.optJSONObject(path) ?: error("Invalid manifest asset")
            val file = ManagedPaths.resolve(trustedRoot, path)
            require(file.isFile && file.length() <= ArchiveLimits.MAX_FILE_BYTES) { "Missing or oversized managed file" }
            totalBytes += file.length()
            require(totalBytes <= ArchiveLimits.MAX_EXTRACTED_BYTES) { "Managed artifact exceeds size limit" }
            val fileHash = StrictJson.string(asset, "fileHash")
            integrity.verifyAsset(file, fileHash, asset.opt("signature").let { if (it == null || it == org.json.JSONObject.NULL) null else it as? String ?: error("Invalid asset signature") })
            fileHashes[path] = fileHash.lowercase()
        }
        val files = mutableSetOf<String>()
        trustedRoot.walkTopDown().forEach { file ->
            if (file != trustedRoot) {
                val path = file.relativeTo(trustedRoot).invariantSeparatorsPath
                require(ManagedPaths.resolve(trustedRoot, path) == file.absoluteFile) { "Untrusted installation path" }
                if (file.isFile) files.add(path) else require(file.isDirectory) { "Special managed file" }
            }
        }
        require(files == paths + "manifest.json") { "Archive contains unlisted managed files" }
        try {
        val metadata = StrictJson.read(ManagedPaths.resolve(trustedRoot, "hot-updater-lynx.json"))
        val version = metadata.opt("schemaVersion")
        val schemaOne = when (version) {
            is BigDecimal -> version.compareTo(BigDecimal.ONE) == 0
            is Number -> version.toDouble() == 1.0
            else -> false
        }
        if (!schemaOne) throw LynxIncompatibleArtifactException("Unsupported Lynx metadata schema")
        val bundleId = StrictJson.string(metadata, "bundleId")
        val platform = StrictJson.string(metadata, "platform")
        val runtime = StrictJson.string(metadata, "runtimeId")
        val entry = StrictJson.string(metadata, "entry")
        require(bundleId == request.bundleId && entry in paths && ManagedPaths.normalize(entry) == entry) { "Invalid Lynx Bundle identity or entry" }
        require(ManagedPaths.resolve(trustedRoot, entry).let { it.isFile && it.length() > 0 }) { "Lynx entry must be a nonempty regular file" }
        if (platform != config.platform || runtime != config.runtimeId) throw LynxIncompatibleArtifactException("Native Lynx compatibility mismatch")
        return VerifiedLynxInstallation(
            bundleId,
            trustedRoot,
            entry,
            runtime,
            HashUtils.calculateSHA256(manifestFile),
            fileHashes,
            manifestBacked,
        )
        } catch (error: LynxIncompatibleArtifactException) { throw error }
        catch (error: Exception) { throw LynxIncompatibleArtifactException(error.message ?: "Invalid Lynx metadata") }
    }
}
