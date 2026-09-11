package com.hotupdater.lynx.internal

import com.hotupdater.lynx.LynxArtifactRequest
import com.hotupdater.lynx.LynxIncompatibleArtifactException
import com.hotupdater.lynx.LynxInstallConfiguration
import com.hotupdater.lynx.VerifiedLynxInstallation
import java.io.File
import java.math.BigDecimal

internal class LynxArtifactVerifier(private val config: LynxInstallConfiguration, private val integrity: ArchiveIntegrity) {
    /** Caller must already have verified the complete archive; this never supplies that authority. */
    fun verify(root: File, request: LynxArtifactRequest): VerifiedLynxInstallation {
        val manifestFile = ManagedPaths.resolve(root, "manifest.json")
        request.manifestFileHash?.let { integrity.verify(manifestFile, it) }
        val manifest = StrictJson.read(manifestFile)
        require(StrictJson.string(manifest, "bundleId") == request.bundleId) { "Manifest Bundle identity mismatch" }
        val assets = manifest.optJSONObject("assets") ?: error("Manifest assets must be an object")
        require(assets.length() in 1..ArchiveLimits.MAX_ENTRIES) { "Invalid manifest asset count" }
        val paths = assets.keys().asSequence().toSet()
        if ("hot-updater-lynx.json" !in paths) throw LynxIncompatibleArtifactException("Missing Lynx metadata")
        require("manifest.json" !in paths) { "Recursive manifest" }
        for (path in paths) {
            require(ManagedPaths.normalize(path) == path) { "Noncanonical manifest path" }
            val asset = assets.optJSONObject(path) ?: error("Invalid manifest asset")
            val file = ManagedPaths.resolve(root, path)
            require(file.isFile && file.length() <= ArchiveLimits.MAX_FILE_BYTES) { "Missing or oversized managed file" }
            integrity.verifyAsset(file, StrictJson.string(asset, "fileHash"), asset.opt("signature").let { if (it == null || it == org.json.JSONObject.NULL) null else it as? String ?: error("Invalid asset signature") })
        }
        val files = mutableSetOf<String>()
        root.walkTopDown().forEach { file ->
            if (file != root) {
                val path = file.relativeTo(root).invariantSeparatorsPath
                require(ManagedPaths.resolve(root, path) == file.absoluteFile) { "Untrusted installation path" }
                if (file.isFile) files.add(path) else require(file.isDirectory) { "Special managed file" }
            }
        }
        require(files == paths + "manifest.json") { "Archive contains unlisted managed files" }
        try {
        val metadata = StrictJson.read(ManagedPaths.resolve(root, "hot-updater-lynx.json"))
        val version = metadata.opt("schemaVersion")
        if (version !is BigDecimal || version.compareTo(BigDecimal.ONE) != 0) throw LynxIncompatibleArtifactException("Unsupported Lynx metadata schema")
        val bundleId = StrictJson.string(metadata, "bundleId")
        val platform = StrictJson.string(metadata, "platform")
        val runtime = StrictJson.string(metadata, "runtimeId")
        val entry = StrictJson.string(metadata, "entry")
        require(bundleId == request.bundleId && entry in paths && ManagedPaths.normalize(entry) == entry) { "Invalid Lynx Bundle identity or entry" }
        require(ManagedPaths.resolve(root, entry).let { it.isFile && it.length() > 0 }) { "Lynx entry must be a nonempty regular file" }
        if (platform != config.platform || runtime != config.runtimeId) throw LynxIncompatibleArtifactException("Native Lynx compatibility mismatch")
        return VerifiedLynxInstallation(bundleId, root, entry, runtime, HashUtils.calculateSHA256(manifestFile), java.util.Collections.unmodifiableSet(paths))
        } catch (error: LynxIncompatibleArtifactException) { throw error }
        catch (error: Exception) { throw LynxIncompatibleArtifactException(error.message ?: "Invalid Lynx metadata") }
    }
}
