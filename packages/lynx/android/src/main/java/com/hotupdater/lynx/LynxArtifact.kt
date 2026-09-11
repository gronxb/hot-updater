package com.hotupdater.lynx

import java.io.File

/** Native-owned settings. Never construct these from a downloaded bundle's arguments. */
data class LynxInstallConfiguration(val runtimeId: String, val publicKeyPem: String? = null) {
    init { require(runtimeId.isNotBlank()) { "Native runtime identity is required" } }
    val platform: String = "android"
}

/** Artifact lookup data is input to verification; it does not authorize selection. */
data class LynxArtifactRequest(val bundleId: String, val fileUrl: String, val fileHash: String, val manifestFileHash: String? = null)

class LynxIncompatibleArtifactException(message: String) : Exception(message)

/** An immutable managed-file snapshot. Only the installer can create one. */
class VerifiedLynxInstallation internal constructor(
    val bundleId: String,
    val directory: File,
    val entry: String,
    val runtimeId: String,
    val manifestHash: String,
    val managedPaths: Set<String>,
)
