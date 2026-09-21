package com.hotupdater.lynx.internal

import com.hotupdater.lynx.LynxArtifactRequest
import com.hotupdater.lynx.LynxIncompatibleArtifactException
import com.hotupdater.lynx.LynxInstallConfiguration
import com.hotupdater.lynx.LynxPageEssentialResources
import com.hotupdater.lynx.VerifiedLynxInstallation
import java.io.File
import java.math.BigDecimal
import org.json.JSONArray
import org.json.JSONObject

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
        val pages = pages(metadata, entry, paths, trustedRoot)
        if (platform != config.platform || runtime != config.runtimeId) throw LynxIncompatibleArtifactException("Native Lynx compatibility mismatch")
        return VerifiedLynxInstallation(
            bundleId = bundleId,
            directory = trustedRoot,
            entry = entry,
            runtimeId = runtime,
            manifestHash = HashUtils.calculateSHA256(manifestFile),
            managedFileHashes = fileHashes,
            manifestBacked = manifestBacked,
            pageEntries = pages.first,
            pageEssentialResources = pages.second,
        )
        } catch (error: LynxIncompatibleArtifactException) { throw error }
        catch (error: Exception) { throw LynxIncompatibleArtifactException(error.message ?: "Invalid Lynx metadata") }
    }

    private fun pages(
        metadata: JSONObject,
        mainEntry: String,
        manifestPaths: Set<String>,
        root: File,
    ): Pair<List<String>, List<LynxPageEssentialResources>> {
        val hasEntries = metadata.has("pageEntries")
        val hasResources = metadata.has("pageEssentialResources")
        require(hasEntries == hasResources) {
            "Lynx page entries and essential resources must be supplied together"
        }
        if (!hasEntries) {
            requirePageEntry(mainEntry, manifestPaths, root)
            return listOf(mainEntry) to listOf(
                LynxPageEssentialResources(mainEntry, listOf(mainEntry)),
            )
        }

        val entries = stringArray(
            metadata.opt("pageEntries"),
            "pageEntries",
        )
        require(entries.isNotEmpty()) { "Lynx page entries must not be empty" }
        require(entries == entries.sortedWith(UTF16_COMPARATOR)) {
            "Lynx page entries must use canonical UTF-16 order"
        }
        val entryNamespace = ManagedPathNamespace()
        entries.forEach { page ->
            entryNamespace.file(page)
            requirePageEntry(page, manifestPaths, root)
        }
        require(entries.count { it == mainEntry } == 1) {
            "Lynx main entry must occur exactly once in page entries"
        }

        val descriptors = metadata.opt("pageEssentialResources") as? JSONArray
            ?: error("Invalid pageEssentialResources")
        require(descriptors.length() == entries.size && descriptors.length() > 0) {
            "Lynx page resource descriptors must match page entries"
        }
        val parsed = (0 until descriptors.length()).map { index ->
            val descriptor = descriptors.opt(index) as? JSONObject
                ?: error("Invalid Lynx page resource descriptor")
            require(descriptor.keys().asSequence().toSet() == setOf("entry", "resources")) {
                "Invalid Lynx page resource descriptor keys"
            }
            val page = StrictJson.string(descriptor, "entry")
            require(page == entries[index]) {
                "Lynx page resource descriptors must match page entry order"
            }
            val resources = stringArray(
                descriptor.opt("resources"),
                "pageEssentialResources.resources",
            )
            require(resources.isNotEmpty() && resources == resources.sortedWith(UTF16_COMPARATOR)) {
                "Lynx page essential resources must be nonempty and sorted"
            }
            val resourceNamespace = ManagedPathNamespace()
            resources.forEach { path ->
                resourceNamespace.file(path)
                require(path in manifestPaths && ManagedPaths.normalize(path) == path) {
                    "Lynx page essential resource is not a managed manifest asset"
                }
            }
            require(page in resources) {
                "Lynx page essential resources must contain the page entry"
            }
            LynxPageEssentialResources(page, resources)
        }
        return entries to parsed
    }

    private fun stringArray(value: Any?, name: String): List<String> {
        val array = value as? JSONArray ?: error("Invalid $name")
        return (0 until array.length()).map { index ->
            (array.opt(index) as? String)?.takeIf(String::isNotEmpty)
                ?: error("Invalid $name value")
        }
    }

    private fun requirePageEntry(
        entry: String,
        manifestPaths: Set<String>,
        root: File,
    ) {
        require(ManagedPaths.normalize(entry) == entry && PAGE_ENTRY.matches(entry)) {
            "Invalid Lynx page entry"
        }
        require(entry in manifestPaths) { "Lynx page entry is not a manifest asset" }
        require(ManagedPaths.resolve(root, entry).let { it.isFile && it.length() > 0 }) {
            "Lynx page entry must be a nonempty regular file"
        }
    }

    private companion object {
        val PAGE_ENTRY = Regex(
            "^(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?/)*" +
                "[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\\.lynx\\.bundle$",
        )
        val UTF16_COMPARATOR = Comparator<String> { first, second ->
            val limit = minOf(first.length, second.length)
            for (index in 0 until limit) {
                val difference = first[index].code - second[index].code
                if (difference != 0) return@Comparator difference
            }
            first.length - second.length
        }
    }
}
