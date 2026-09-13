package com.hotupdater.lynx

import android.content.Context
import com.hotupdater.lynx.internal.ArchiveIntegrity
import com.hotupdater.lynx.internal.DurableFiles
import com.hotupdater.lynx.internal.LynxArtifactVerifier
import com.hotupdater.lynx.internal.ManagedPaths
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/** All scope, compatibility and embedded identities originate in native application code. */
data class LynxHostConfiguration(
    val runtimeId: String,
    val channel: String,
    val appVersion: String,
    val embeddedAssetDirectory: String,
    val embeddedBundleId: String,
    val embeddedManifestHash: String,
    val minimumBundleId: String,
    val cohort: String,
    val publicKeyPem: String? = null,
    val fingerprintHash: String? = null,
) {
    init {
        require(embeddedBundleId.isNotBlank()) {
            "Native embedded Bundle identity is required"
        }
        require(Regex("[0-9a-f]{64}").matches(embeddedManifestHash)) {
            "Native embedded manifest hash is required"
        }
        require(minimumBundleId.isNotBlank()) {
            "Native minimum Bundle identity is required"
        }
    }
}

internal fun digestString(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }

internal fun verifyEmbeddedIdentity(
    manifestBytes: ByteArray,
    config: LynxHostConfiguration,
): JSONObject {
    val digest = MessageDigest.getInstance("SHA-256")
        .digest(manifestBytes)
        .joinToString("") { "%02x".format(it) }
    check(digest == config.embeddedManifestHash) {
        "Embedded manifest does not match the native package identity"
    }
    return JSONObject(String(manifestBytes)).also { manifest ->
        check(manifest.getString("bundleId") == config.embeddedBundleId) {
            "Embedded Bundle does not match the native package identity"
        }
    }
}

internal fun loadEmbedded(context: Context, config: LynxHostConfiguration): VerifiedLynxInstallation {
    val configured = File(config.embeddedAssetDirectory)
    if (configured.isAbsolute && configured.isDirectory) {
        val manifestFile = File(configured, "manifest.json")
        val manifestBytes = manifestFile.readBytes()
        verifyEmbeddedIdentity(manifestBytes, config)
        val request = LynxArtifactRequest(
            config.embeddedBundleId,
            "native-embedded",
            "native-embedded",
            config.embeddedManifestHash,
        )
        return LynxArtifactVerifier(
            LynxInstallConfiguration(config.runtimeId),
            ArchiveIntegrity(null),
        ).verify(configured.canonicalFile, request).also {
            check(it.bundleId == config.embeddedBundleId)
            check(it.manifestHash == config.embeddedManifestHash)
        }
    }
    val manifestBytes = context.assets.open("${config.embeddedAssetDirectory}/manifest.json").use { it.readBytes() }
    val nativeManifest = verifyEmbeddedIdentity(manifestBytes, config)
    val root = File(
        context.filesDir,
        "hot-updater-lynx/embedded/${config.embeddedManifestHash}",
    ).canonicalFile
    synchronized(embeddedLock) {
        if (!root.exists()) {
            val staging = File(root.parentFile, "${config.embeddedManifestHash}.tmp")
            staging.deleteRecursively(); DurableFiles.directory(staging)
            val paths = nativeManifest.getJSONObject("assets").keys().asSequence().toSet() + "manifest.json"
            try {
                paths.forEach { path ->
                    val target = ManagedPaths.resolve(staging, path)
                    DurableFiles.directory(target.parentFile!!)
                    context.assets.open("${config.embeddedAssetDirectory}/$path").use { input ->
                        FileOutputStream(target).use { output -> input.copyTo(output); output.fd.sync() }
                    }
                }
                staging.walkBottomUp().filter { it.isDirectory }.forEach(DurableFiles::syncDirectory)
                check(staging.renameTo(root)) { "Could not publish native embedded files" }
                DurableFiles.syncDirectory(root.parentFile!!)
            } finally { staging.deleteRecursively() }
        }
        // The APK is the embedded trust anchor. OTA signing policy applies to downloads.
        val request = LynxArtifactRequest(
            config.embeddedBundleId,
            "native-embedded",
            "native-embedded",
            config.embeddedManifestHash,
        )
        return LynxArtifactVerifier(
            LynxInstallConfiguration(config.runtimeId),
            ArchiveIntegrity(null),
        ).verify(root, request).also {
            check(it.bundleId == config.embeddedBundleId)
            check(it.manifestHash == config.embeddedManifestHash)
        }
    }
}

private val embeddedLock = Any()
