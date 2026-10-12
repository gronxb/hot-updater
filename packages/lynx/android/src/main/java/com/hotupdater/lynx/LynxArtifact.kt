package com.hotupdater.lynx

import com.hotupdater.lynx.internal.ArchiveLimits
import com.hotupdater.lynx.internal.ManagedPathNamespace
import java.io.File
import org.json.JSONObject

/** Native-owned settings. Never construct these from a downloaded bundle's arguments. */
data class LynxInstallConfiguration(val runtimeId: String, val publicKeyPem: String? = null) {
    init { require(runtimeId.isNotBlank()) { "Native runtime identity is required" } }
    val platform: String = "android"
}

/** Artifact lookup data is input to verification; it does not authorize selection. */
data class LynxChangedFile(
    val url: String,
    val compression: String? = null,
)

data class LynxAssetPatch(
    val algorithm: String,
    val baseBundleId: String,
    val baseFileHash: String,
    val patchFileHash: String,
    val patchUrl: String,
    val byteSize: Long? = null,
)

data class LynxChangedAsset(
    val fileHash: String,
    val file: LynxChangedFile? = null,
    val patch: LynxAssetPatch? = null,
)

data class LynxArtifactRequest(
    val bundleId: String,
    val manifestUrl: String? = null,
    val manifestFileHash: String? = null,
    val assets: Map<String, LynxChangedAsset>? = null,
    val archiveUrl: String? = null,
    val artifactProtocolVersion: Int = 1,
) {
    internal fun validateForPreparation() {
        require(UUID_V7.matches(bundleId)) { "Invalid Bundle ID" }
        require(artifactProtocolVersion == 1) { "Unsupported artifact protocol" }
        require(manifestUrl != null && manifestFileHash != null && !assets.isNullOrEmpty()) {
            "Incomplete manifest-v1 descriptor"
        }
        requireHttpUrl(manifestUrl, "manifest")
        require(isIntegrityToken(manifestFileHash)) { "Invalid manifest integrity token" }
        archiveUrl?.let { requireHttpUrl(it, "archive") }
        require(assets.size <= ArchiveLimits.MAX_ENTRIES) { "Too many target assets" }
        val namespace = ManagedPathNamespace()
        namespace.file("manifest.json")
        assets.forEach { (path, asset) ->
            namespace.file(path)
            require(HASH.matches(asset.fileHash)) { "Invalid target asset hash" }
            val file = requireNotNull(asset.file) { "Every target asset requires an original file" }
            require(file.compression == null || file.compression == "br") { "Unsupported target asset compression" }
            requireHttpUrl(file.url, "target asset")
            asset.patch?.let { patch ->
                require(patch.algorithm == "bsdiff") { "Unsupported patch algorithm" }
                require(UUID_V7.matches(patch.baseBundleId)) { "Invalid patch base Bundle ID" }
                require(HASH.matches(patch.baseFileHash) && HASH.matches(patch.patchFileHash)) { "Invalid patch integrity metadata" }
                require(patch.byteSize == null || patch.byteSize in 1..ArchiveLimits.MAX_FILE_BYTES) { "Invalid patch size" }
                requireHttpUrl(patch.patchUrl, "patch")
            }
        }
    }

    companion object {
        private val HASH = Regex("[0-9a-fA-F]{64}")
        private val UUID_V7 = Regex(
            "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        )
        private val SIGNATURE = Regex(
            "sig:(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?",
        )

        private fun isIntegrityToken(value: String) = HASH.matches(value) ||
            (value.length > 4 && SIGNATURE.matches(value))

        private fun requireHttpUrl(value: String, kind: String) {
            val url = java.net.URL(value)
            require(
                (url.protocol == "https" || url.protocol == "http") &&
                    url.host.isNotBlank() &&
                    url.userInfo == null &&
                    (url.port == -1 || url.port in 1..65535) &&
                    value.none { it <= '\u0020' || it == '\u007f' || it == '\\' },
            ) {
                "Invalid $kind URL"
            }
        }

        internal fun fromJson(value: JSONObject): LynxArtifactRequest {
            fun requiredString(json: JSONObject, key: String): String =
                (json.opt(key) as? String)?.takeIf(String::isNotBlank)
                    ?: error("Invalid $key")
            fun optionalString(json: JSONObject, key: String): String? = json.opt(key).let {
                if (it == null || it == JSONObject.NULL) null else it as? String ?: error("Invalid $key")
            }
            fun optionalObject(json: JSONObject, key: String): JSONObject? = json.opt(key).let {
                if (it == null || it == JSONObject.NULL) null else it as? JSONObject ?: error("Invalid $key")
            }
            val changes = optionalObject(value, "assets")?.let { assets ->
                require(assets.length() <= ArchiveLimits.MAX_ENTRIES) { "Too many changed assets" }
                assets.keys().asSequence().associateWith { path ->
                    val asset = assets.getJSONObject(path)
                    val file = optionalObject(asset, "file")?.let {
                        LynxChangedFile(requiredString(it, "url"), optionalString(it, "compression"))
                    }
                    val patch = optionalObject(asset, "patch")?.let {
                        LynxAssetPatch(
                            requiredString(it, "algorithm"),
                            requiredString(it, "baseBundleId"),
                            requiredString(it, "baseFileHash"),
                            requiredString(it, "patchFileHash"),
                            requiredString(it, "patchUrl"),
                            it.opt("byteSize").let { size ->
                                if (size == null || size == JSONObject.NULL) null
                                else {
                                    require(size is Number && size.toDouble() == size.toLong().toDouble()) { "Invalid patch size" }
                                    size.toLong()
                                }
                            },
                        )
                    }
                    LynxChangedAsset(requiredString(asset, "fileHash"), file, patch)
                }
            }
            return LynxArtifactRequest(
                requiredString(value, "bundleId"),
                manifestUrl = requiredString(value, "manifestUrl"),
                manifestFileHash = requiredString(value, "manifestFileHash"),
                assets = changes,
                archiveUrl = optionalString(value, "archiveUrl"),
                artifactProtocolVersion = if ((value.opt("artifactProtocolVersion") as? Number)?.toDouble() == 1.0) 1 else error("Unsupported artifact protocol"),
            ).also(LynxArtifactRequest::validateForPreparation)
        }
    }
}

class LynxIncompatibleArtifactException(message: String) : Exception(message)

data class LynxPageEssentialResources internal constructor(
    val entry: String,
    val resources: List<String>,
)

data class LynxLogicalPage(
    val entry: String,
    val parameters: Map<String, String> = emptyMap(),
    /** Native container identity; absent for a navigation stack. */
    val mountId: String? = null,
)

data class LynxManagedTransition internal constructor(
    val transitionId: String,
    val trigger: String,
    val sourceGenerationId: String,
    val stack: List<LynxLogicalPage>,
)

/** An immutable managed-file snapshot. Only the installer can create one. */
class VerifiedLynxInstallation internal constructor(
    val bundleId: String,
    val directory: File,
    val entry: String,
    val runtimeId: String,
    val manifestHash: String,
    managedFileHashes: Map<String, String>,
    internal val manifestBacked: Boolean = false,
    val backgroundEntry: String? = null,
    pageEntries: List<String> = listOf(entry),
    pageEssentialResources: List<LynxPageEssentialResources> = listOf(
        LynxPageEssentialResources(entry, listOf(entry)),
    ),
) {
    val pageEntries: List<String> =
        java.util.Collections.unmodifiableList(ArrayList(pageEntries))
    val pageEssentialResources: List<LynxPageEssentialResources> =
        java.util.Collections.unmodifiableList(
            pageEssentialResources.map {
                LynxPageEssentialResources(
                    it.entry,
                    java.util.Collections.unmodifiableList(ArrayList(it.resources)),
                )
            },
        )
    val managedFileHashes: Map<String, String> =
        java.util.Collections.unmodifiableMap(HashMap(managedFileHashes))
    val managedPaths: Set<String> get() = managedFileHashes.keys

    fun essentialResources(pageEntry: String): List<String> =
        pageEssentialResources.singleOrNull { it.entry == pageEntry }?.resources
            ?: throw IllegalArgumentException("Unknown managed page entry")
}
