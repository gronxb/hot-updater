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
)

data class LynxChangedAsset(
    val fileHash: String,
    val file: LynxChangedFile? = null,
    val patch: LynxAssetPatch? = null,
)

data class LynxArtifactRequest(
    val bundleId: String,
    val fileUrl: String?,
    val fileHash: String?,
    val manifestFileHash: String? = null,
    val manifestUrl: String? = null,
    val changedAssets: Map<String, LynxChangedAsset>? = null,
) {
    internal val hasArchive get() = !fileUrl.isNullOrBlank() && !fileHash.isNullOrBlank()
    internal val hasDelta get() = !manifestUrl.isNullOrBlank() && !manifestFileHash.isNullOrBlank() && changedAssets != null

    internal fun validateForPreparation() {
        require(UUID_V7.matches(bundleId)) { "Invalid Bundle ID" }
        require((fileUrl == null) == (fileHash == null)) {
            "Incomplete archive delivery descriptor"
        }
        if (fileUrl != null) {
            requireHttpUrl(fileUrl, "archive")
            require(isIntegrityToken(checkNotNull(fileHash))) {
                "Invalid archive integrity token"
            }
        }
        val hasManifestDeliveryField = manifestUrl != null || changedAssets != null
        if (hasManifestDeliveryField) {
            require(manifestUrl != null && manifestFileHash != null && changedAssets != null) {
                "Incomplete manifest delivery descriptor"
            }
        }
        manifestFileHash?.let {
            require(isIntegrityToken(it)) { "Invalid manifest integrity token" }
        }
        if (manifestUrl != null) requireHttpUrl(manifestUrl, "manifest")
        require(hasArchive || hasDelta) { "Artifact has no complete delivery descriptor" }

        require((changedAssets?.size ?: 0) <= ArchiveLimits.MAX_ENTRIES) {
            "Too many changed assets"
        }
        val changedNamespace = ManagedPathNamespace()
        changedNamespace.file("manifest.json")
        changedAssets?.forEach { (path, asset) ->
            changedNamespace.file(path)
            require(HASH.matches(asset.fileHash)) { "Invalid changed asset hash" }
            require(asset.file != null || asset.patch != null) {
                "Changed asset has no delivery source"
            }
            asset.file?.let { file ->
                require(file.compression == null || file.compression == "br") {
                    "Unsupported changed asset compression"
                }
                requireHttpUrl(file.url, "changed asset")
            }
            asset.patch?.let { patch ->
                require(patch.algorithm == "bsdiff") { "Unsupported patch algorithm" }
                require(UUID_V7.matches(patch.baseBundleId)) { "Invalid patch base Bundle ID" }
                require(HASH.matches(patch.baseFileHash) && HASH.matches(patch.patchFileHash)) {
                    "Invalid patch integrity metadata"
                }
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
            val changes = optionalObject(value, "changedAssets")?.let { assets ->
                require(assets.length() <= ArchiveLimits.MAX_ENTRIES) { "Too many changed assets" }
                assets.keys().asSequence().associateWith { path ->
                    val asset = assets.getJSONObject(path)
                    require(asset.has("file") && asset.has("patch")) {
                        "Changed asset delivery fields are required"
                    }
                    val file = optionalObject(asset, "file")?.let {
                        require(it.has("compression")) {
                            "Changed asset compression must be explicit"
                        }
                        LynxChangedFile(requiredString(it, "url"), optionalString(it, "compression"))
                    }
                    val patch = optionalObject(asset, "patch")?.let {
                        LynxAssetPatch(
                            requiredString(it, "algorithm"),
                            requiredString(it, "baseBundleId"),
                            requiredString(it, "baseFileHash"),
                            requiredString(it, "patchFileHash"),
                            requiredString(it, "patchUrl"),
                        )
                    }
                    LynxChangedAsset(requiredString(asset, "fileHash"), file, patch)
                }
            }
            return LynxArtifactRequest(
                requiredString(value, "bundleId"),
                optionalString(value, "fileUrl"),
                optionalString(value, "fileHash"),
                optionalString(value, "manifestFileHash"),
                optionalString(value, "manifestUrl"),
                changes,
            ).also(LynxArtifactRequest::validateForPreparation)
        }
    }
}

class LynxIncompatibleArtifactException(message: String) : Exception(message)

/** An immutable managed-file snapshot. Only the installer can create one. */
class VerifiedLynxInstallation internal constructor(
    val bundleId: String,
    val directory: File,
    val entry: String,
    val runtimeId: String,
    val manifestHash: String,
    managedFileHashes: Map<String, String>,
    internal val manifestBacked: Boolean = false,
) {
    val managedFileHashes: Map<String, String> =
        java.util.Collections.unmodifiableMap(HashMap(managedFileHashes))
    val managedPaths: Set<String> get() = managedFileHashes.keys
}
